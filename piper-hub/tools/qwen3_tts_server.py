"""
Qwen3-TTS local microservice for Piper (TTS + Clone + optional Voice-Design).

Goals:
- CUDA only (no silent CPU fallback)
- Clone without SoX (ffmpeg decode -> numpy)
- Warmup endpoint to load models
- Voice design is used ONLY if the selected design model actually supports it (probe once; never pretend).

Models:
- TTS model: typically CustomVoice (expressive/emotion via instruct)
- Clone model: must support generate_voice_clone (default: Base)
- Design model: must support generate_voice_design (default: Base) — probed at runtime

Env:
- QWEN3_HOST / QWEN3_PORT
- QWEN3_DEVICE=cuda (required) / QWEN3_CUDA_INDEX
- QWEN3_MODEL_TYPE / QWEN3_MODEL_SIZE                 (TTS)   default: CustomVoice / 0.6B
- QWEN3_CLONE_MODEL_TYPE / QWEN3_CLONE_MODEL_SIZE     (Clone) default: Base / 0.6B
- QWEN3_DESIGN_MODEL_TYPE / QWEN3_DESIGN_MODEL_SIZE   (Design) default: Base / 0.6B
- QWEN3_DEFAULT_REF_AUDIO  (e.g. E:\\AI\\Voice\\voice.mp3) for imitation mode fallback
- QWEN3_FFMPEG_EXE (path to ffmpeg.exe) or ffmpeg on PATH
- QWEN3_WARMUP=1 to call /warmup on startup (handled by start-piper.ps1)
"""

import io
import os
import tempfile
import traceback
import threading
from typing import Optional, Tuple

import numpy as np
import torch
from fastapi import FastAPI, Body
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

# ---------------- Config ----------------

HOST = os.environ.get("QWEN3_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN3_PORT", "5005"))

DEVICE = os.environ.get("QWEN3_DEVICE", "cuda").lower()
CUDA_INDEX = int(os.environ.get("QWEN3_CUDA_INDEX", "0"))

MODEL_TYPE = os.environ.get("QWEN3_MODEL_TYPE", "CustomVoice")
MODEL_SIZE = os.environ.get("QWEN3_MODEL_SIZE", "0.6B")

CLONE_MODEL_TYPE = os.environ.get("QWEN3_CLONE_MODEL_TYPE", "Base")
CLONE_MODEL_SIZE = os.environ.get("QWEN3_CLONE_MODEL_SIZE", "0.6B")

DESIGN_MODEL_TYPE = os.environ.get("QWEN3_DESIGN_MODEL_TYPE", "Base")
DESIGN_MODEL_SIZE = os.environ.get("QWEN3_DESIGN_MODEL_SIZE", "0.6B")

DTYPE_ENV = os.environ.get("QWEN3_DTYPE", "float32").lower()
ATTN = os.environ.get("QWEN3_ATTN", "eager")
DTYPE = torch.float16 if DTYPE_ENV in ("float16", "fp16") else torch.float32

DEFAULT_REF_AUDIO = os.environ.get("QWEN3_DEFAULT_REF_AUDIO", "").strip()
FFMPEG_EXE = os.environ.get("QWEN3_FFMPEG_EXE", "").strip() or "ffmpeg"

# ---------------- TLS Fix ----------------

def ensure_ca_bundle():
    for v in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        p = os.environ.get(v)
        if p and not os.path.exists(p):
            os.environ.pop(v, None)
    try:
        import certifi
        ca = certifi.where()
        if os.path.exists(ca):
            os.environ["SSL_CERT_FILE"] = ca
            os.environ["REQUESTS_CA_BUNDLE"] = ca
            os.environ["CURL_CA_BUNDLE"] = ca
    except Exception:
        pass

ensure_ca_bundle()

# ---------------- Qwen Import ----------------

try:
    from qwen_tts import Qwen3TTSModel
except Exception as e:
    Qwen3TTSModel = None
    IMPORT_ERR = e
else:
    IMPORT_ERR = None

# ---------------- Voice Design Cache ----------------
# Cache reusable "voice design" prompt objects keyed by base description.

VOICE_DESIGN_CACHE = {}
_VOICE_DESIGN_CREATOR_NAME = None
_VOICE_DESIGN_GEN_SIG = None

def _init_voice_design_introspection(model):
    """Inspect the model once so we can call voice-design methods safely."""
    global _VOICE_DESIGN_CREATOR_NAME, _VOICE_DESIGN_GEN_SIG
    _VOICE_DESIGN_CREATOR_NAME = None
    _VOICE_DESIGN_GEN_SIG = None
    try:
        import inspect as _inspect
        if hasattr(model, "generate_voice_design") and callable(getattr(model, "generate_voice_design")):
            _VOICE_DESIGN_GEN_SIG = _inspect.signature(getattr(model, "generate_voice_design"))
        # Find a creator method if the model exposes one (no assumptions: we search actual attributes).
        candidates = []
        for name in dir(model):
            if not name.startswith("create_"):
                continue
            if "voice" in name and "design" in name:
                fn = getattr(model, name, None)
                if callable(fn):
                    candidates.append(name)
        _VOICE_DESIGN_CREATOR_NAME = candidates[0] if candidates else None
    except Exception:
        _VOICE_DESIGN_CREATOR_NAME = None
        _VOICE_DESIGN_GEN_SIG = None

def get_or_create_voice_design_prompt(model, base_desc: str):
    """Return a cached voice-design prompt object when supported."""
    if not base_desc:
        return None
    key = base_desc.strip()
    if not key:
        return None
    if key in VOICE_DESIGN_CACHE:
        return VOICE_DESIGN_CACHE[key]

    if _VOICE_DESIGN_GEN_SIG is None and _VOICE_DESIGN_CREATOR_NAME is None:
        _init_voice_design_introspection(model)

    if not _VOICE_DESIGN_CREATOR_NAME:
        return None

    creator = getattr(model, _VOICE_DESIGN_CREATOR_NAME, None)
    if not callable(creator):
        return None

    print(f"[qwen3] creating voice design prompt via '{_VOICE_DESIGN_CREATOR_NAME}' for: {key}")
    prompt = creator(key)
    VOICE_DESIGN_CACHE[key] = prompt
    return prompt

def call_generate_voice_design(model, *, text: str, language: str, base_desc: str, emotion_instruct: str):
    """Safely call generate_voice_design when supported; returns (wavs, sr) or None."""
    if not hasattr(model, "generate_voice_design") or not callable(getattr(model, "generate_voice_design")):
        return None

    if _VOICE_DESIGN_GEN_SIG is None and _VOICE_DESIGN_CREATOR_NAME is None:
        _init_voice_design_introspection(model)

    sig = _VOICE_DESIGN_GEN_SIG
    if sig is None:
        return None

    kwargs = {}
    params = set(sig.parameters.keys())

    if "text" in params:
        kwargs["text"] = text
    if "language" in params:
        kwargs["language"] = language

    # Some implementations accept the base description directly.
    if "description" in params:
        kwargs["description"] = base_desc

    # Emotion / instruct parameters vary.
    if "instruct" in params:
        kwargs["instruct"] = emotion_instruct
    if "emotion" in params and "emotion" not in kwargs:
        kwargs["emotion"] = emotion_instruct

    # If it accepts a prompt object, create/cache one.
    for p in ("prompt", "voice_design_prompt", "design_prompt"):
        if p in params:
            prompt_obj = get_or_create_voice_design_prompt(model, base_desc)
            if prompt_obj is None:
                return None
            kwargs[p] = prompt_obj
            break

    # If we cannot provide required args, skip.
    required = [
        n for n, p in sig.parameters.items()
        if p.default is p.empty and p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)
    ]
    missing = [n for n in required if n not in kwargs]
    if missing:
        return None

    return model.generate_voice_design(**kwargs)

# ---------------- Globals ----------------

app = FastAPI(title="Qwen3-TTS")

_model_tts: Optional["Qwen3TTSModel"] = None
_model_clone: Optional["Qwen3TTSModel"] = None
_model_design: Optional["Qwen3TTSModel"] = None

LOAD_ERROR_TTS: Optional[str] = None
LOAD_ERROR_CLONE: Optional[str] = None
LOAD_ERROR_DESIGN: Optional[str] = None

# design support is probed; None=unknown, True/False known.
DESIGN_SUPPORTED: Optional[bool] = None
DESIGN_DISABLED_REASON: Optional[str] = None

INFER_LOCK = threading.Lock()
LAST_ERR: Optional[str] = None
LAST_TB: Optional[str] = None

# ---------------- Helpers ----------------

def _mid(size: str, mtype: str) -> str:
    return f"Qwen/Qwen3-TTS-12Hz-{size}-{mtype}"

def _device_map():
    if DEVICE != "cuda":
        raise RuntimeError("QWEN3_DEVICE must be 'cuda' (CPU fallback disabled).")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available (torch.cuda.is_available() is False).")
    return f"cuda:{CUDA_INDEX}"

def _load(size: str, mtype: str) -> "Qwen3TTSModel":
    if Qwen3TTSModel is None:
        raise RuntimeError(f"Import failed: {IMPORT_ERR}")
    mid = _mid(size, mtype)
    dmap = _device_map()
    print(f"[qwen3] loading {mid} | {dmap} | {DTYPE}")
    model = Qwen3TTSModel.from_pretrained(
        mid,
        device_map=dmap,
        dtype=DTYPE,
        attn_implementation=ATTN,
    )
    print(f"[qwen3] model ready: {mid}")
    return model

def load_tts():
    global _model_tts, LOAD_ERROR_TTS, LAST_ERR, LAST_TB
    if _model_tts is not None:
        return _model_tts
    if LOAD_ERROR_TTS:
        raise RuntimeError(LOAD_ERROR_TTS)
    try:
        _model_tts = _load(MODEL_SIZE, MODEL_TYPE)
        return _model_tts
    except Exception as e:
        LAST_ERR = f"{type(e).__name__}: {e}"
        LAST_TB = traceback.format_exc()
        LOAD_ERROR_TTS = LAST_ERR
        print("[qwen3] TTS LOAD ERROR:", LAST_ERR)
        print(LAST_TB)
        raise

def load_clone():
    global _model_clone, LOAD_ERROR_CLONE, LAST_ERR, LAST_TB
    if _model_clone is not None:
        return _model_clone
    if LOAD_ERROR_CLONE:
        raise RuntimeError(LOAD_ERROR_CLONE)
    try:
        _model_clone = _load(CLONE_MODEL_SIZE, CLONE_MODEL_TYPE)
        return _model_clone
    except Exception as e:
        LAST_ERR = f"{type(e).__name__}: {e}"
        LAST_TB = traceback.format_exc()
        LOAD_ERROR_CLONE = LAST_ERR
        print("[qwen3] CLONE LOAD ERROR:", LAST_ERR)
        print(LAST_TB)
        raise

def load_design():
    global _model_design, LOAD_ERROR_DESIGN, LAST_ERR, LAST_TB
    if _model_design is not None:
        return _model_design
    if LOAD_ERROR_DESIGN:
        raise RuntimeError(LOAD_ERROR_DESIGN)
    try:
        _model_design = _load(DESIGN_MODEL_SIZE, DESIGN_MODEL_TYPE)
        return _model_design
    except Exception as e:
        LAST_ERR = f"{type(e).__name__}: {e}"
        LAST_TB = traceback.format_exc()
        LOAD_ERROR_DESIGN = LAST_ERR
        print("[qwen3] DESIGN LOAD ERROR:", LAST_ERR)
        print(LAST_TB)
        raise

def _disable_design(reason: str):
    global DESIGN_SUPPORTED, DESIGN_DISABLED_REASON
    DESIGN_SUPPORTED = False
    DESIGN_DISABLED_REASON = reason

def probe_design_support() -> bool:
    """
    Probe once whether the DESIGN model can actually run generate_voice_design.
    Grounded: we attempt a tiny call; if the model says "does not support", we disable permanently.
    """
    global DESIGN_SUPPORTED, DESIGN_DISABLED_REASON
    if DESIGN_SUPPORTED is not None:
        return bool(DESIGN_SUPPORTED)

    try:
        m = load_design()
    except Exception as e:
        _disable_design(f"design model failed to load: {e}")
        return False

    # Try to build kwargs via signature introspection; if we can't, treat as unsupported (but not an error).
    test_desc = "Test voice design."
    test_text = "Hello."
    test_lang = "english"
    test_instruct = "Neutral."

    try:
        out = call_generate_voice_design(
            m, text=test_text, language=test_lang, base_desc=test_desc, emotion_instruct=test_instruct
        )
        if out is None:
            _disable_design("generate_voice_design signature unsupported by introspection")
            return False

        # Some implementations may still raise inside generate_voice_design()
        _wavs, _sr = out
        DESIGN_SUPPORTED = True
        DESIGN_DISABLED_REASON = None
        print("[qwen3] voice design probe: supported=True")
        return True

    except ValueError as e:
        msg = str(e)
        if "does not support generate_voice_design" in msg:
            print("[qwen3] voice design disabled (model does not support it):", msg)
            _disable_design(msg)
            return False
        # other ValueErrors: treat as failure but keep reason
        print("[qwen3] voice design probe failed:", msg)
        _disable_design(msg)
        return False

    except Exception as e:
        # Conservative: disable if probe throws.
        msg = f"{type(e).__name__}: {e}"
        print("[qwen3] voice design probe failed:", msg)
        _disable_design(msg)
        return False

def wav_bytes(sr, wav):
    import wave
    wav = np.asarray(wav, dtype=np.float32).flatten()
    wav = np.clip(wav, -1.0, 1.0)
    pcm = (wav * 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sr))
        wf.writeframes(pcm.tobytes())

    return buf.getvalue()

def decode_ref_audio_to_numpy(ref_path: str, target_sr: int = 24000) -> Tuple[np.ndarray, int]:
    """Decode audio file -> mono WAV at target_sr via ffmpeg, then load to numpy float32."""
    import subprocess
    import wave

    if not ref_path or not os.path.exists(ref_path):
        raise FileNotFoundError(f"ref_audio not found: {ref_path}")

    with tempfile.TemporaryDirectory() as td:
        out_wav = os.path.join(td, "ref.wav")
        cmd = [
            FFMPEG_EXE,
            "-y",
            "-i",
            ref_path,
            "-ac",
            "1",
            "-ar",
            str(int(target_sr)),
            "-vn",
            out_wav,
        ]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True)
        except FileNotFoundError:
            raise RuntimeError(
                f"ffmpeg not found. Set QWEN3_FFMPEG_EXE to your ffmpeg.exe path, or put ffmpeg on PATH. Tried: {FFMPEG_EXE}"
            )
        if p.returncode != 0:
            raise RuntimeError(f"ffmpeg failed ({p.returncode}): {p.stderr.strip()[:600]}")

        with wave.open(out_wav, "rb") as wf:
            sr = wf.getframerate()
            n = wf.getnframes()
            sampwidth = wf.getsampwidth()
            nch = wf.getnchannels()
            raw = wf.readframes(n)

        if nch != 1:
            raise RuntimeError("decoded ref audio is not mono (unexpected)")
        if sampwidth == 2:
            audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        elif sampwidth == 4:
            audio = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            raise RuntimeError(f"unsupported sample width: {sampwidth}")

        return audio, int(sr)

# ---------------- API ----------------

class SpeakReq(BaseModel):
    text: str
    voice: str = "ryan"
    language: str = "english"
    instruct: str = "Neutral."
    ref_audio: Optional[str] = None
    voice_id: Optional[str] = None
    custom_description: Optional[str] = None

@app.get("/health")
def health():
    return {
        "ok": True,
        "device": DEVICE,
        "dtype": str(DTYPE),
        "tts_model_id": _mid(MODEL_SIZE, MODEL_TYPE),
        "clone_model_id": _mid(CLONE_MODEL_SIZE, CLONE_MODEL_TYPE),
        "design_model_id": _mid(DESIGN_MODEL_SIZE, DESIGN_MODEL_TYPE),
        "tts_loaded": _model_tts is not None,
        "clone_loaded": _model_clone is not None,
        "design_loaded": _model_design is not None,
        "design_supported": DESIGN_SUPPORTED,
        "design_disabled_reason": DESIGN_DISABLED_REASON,
        "load_error_tts": LOAD_ERROR_TTS,
        "load_error_clone": LOAD_ERROR_CLONE,
        "load_error_design": LOAD_ERROR_DESIGN,
        "default_ref_audio": DEFAULT_REF_AUDIO,
        "ffmpeg": FFMPEG_EXE,
    }

@app.get("/capabilities")
def capabilities():
    # We do not force-load models here; just report config + known probe result.
    return {
        "ok": True,
        "tts_model_id": _mid(MODEL_SIZE, MODEL_TYPE),
        "clone_model_id": _mid(CLONE_MODEL_SIZE, CLONE_MODEL_TYPE),
        "design_model_id": _mid(DESIGN_MODEL_SIZE, DESIGN_MODEL_TYPE),
        "design_supported": DESIGN_SUPPORTED,
        "design_disabled_reason": DESIGN_DISABLED_REASON,
    }

@app.get("/warmup")
def warmup():
    # Load all configured models and probe design support.
    try:
        load_tts()
        load_clone()
        load_design()
        probe_design_support()
        return {
            "ok": True,
            "tts_loaded": True,
            "clone_loaded": True,
            "design_loaded": True,
            "design_supported": DESIGN_SUPPORTED,
        }
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": str(e), "traceback": traceback.format_exc()},
        )

@app.get("/last_error")
def last_error():
    return {"ok": True, "error": LAST_ERR, "traceback": LAST_TB}

@app.post("/speak")
def speak(req: SpeakReq = Body(...)):
    global LAST_ERR, LAST_TB

    text = (req.text or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Empty text"})

    raw_voice = (req.voice or "").strip().lower()
    language = (req.language or "english").strip().lower()
    instruct = (req.instruct or "").strip()

    ref_audio = (req.ref_audio or "").strip()
    voice_id = (req.voice_id or "").strip()  # currently unused; kept for forward-compat
    custom_desc = (req.custom_description or "").strip()

    # Imitation fallback reference audio
    if not ref_audio and raw_voice == "imitation" and DEFAULT_REF_AUDIO:
        ref_audio = DEFAULT_REF_AUDIO

    print(
        f"[qwen3] /speak voice='{raw_voice}' ref_audio='{ref_audio}' voice_id='{voice_id}' "
        f"custom_desc_len={len(custom_desc)} text_len={len(text)}"
    )

    # Map Piper modes to a baseline speaker; models may ignore.
    speaker = raw_voice
    if speaker in ("default_female", "default-female", "female", "custom", "imitation"):
        speaker = "vivian"

    # If we're in 'custom' mode and we have a description, combine it with emotion in a stable way.
    # This is used for fallback paths too (even if voice design isn't supported).
    emotion_instruct = instruct.strip() or "Neutral."
    if custom_desc:
        # Keep this deterministic and readable; avoid bloating prompts.
        # First line is identity; second line is delivery.
        merged_instruct = f"Voice identity: {custom_desc}\nDelivery: {emotion_instruct}"
    else:
        merged_instruct = emotion_instruct

    try:
        wants_clone = bool(ref_audio)

        with INFER_LOCK, torch.inference_mode():
            if wants_clone:
                # ---- Clone path ----
                clone_model = load_clone()
                if not hasattr(clone_model, "generate_voice_clone"):
                    return JSONResponse(status_code=500, content={"ok": False, "error": "clone model has no generate_voice_clone()"})

                audio_np, sr = decode_ref_audio_to_numpy(ref_audio, target_sr=24000)

                # Qwen clone requires ref_text unless x_vector_only_mode=True
                wavs, out_sr = clone_model.generate_voice_clone(
                    text=text,
                    language=language,
                    ref_audio=(audio_np, sr),
                    x_vector_only_mode=True,
                    non_streaming_mode=False,
                    max_new_tokens=512,
                    do_sample=False,
                )
                wav = wavs[0]

            else:
                # ---- Non-clone path: Design (if supported) else CustomVoice/Generate ----
                wav = None
                out_sr = 24000

                # Use design only for "custom" voice and only if we have a description.
                if raw_voice == "custom" and custom_desc:
                    if probe_design_support():
                        try:
                            design_model = load_design()
                            out = call_generate_voice_design(
                                design_model,
                                text=text,
                                language=language,
                                base_desc=custom_desc,
                                emotion_instruct=emotion_instruct,
                            )
                            if out is not None:
                                wavs, out_sr = out
                                wav = wavs[0]
                            else:
                                # If introspection can't map args, treat as unsupported.
                                _disable_design("generate_voice_design signature unsupported by introspection")
                        except ValueError as e:
                            msg = str(e)
                            if "does not support generate_voice_design" in msg:
                                print("[qwen3] voice design disabled (model does not support it):", msg)
                                _disable_design(msg)
                            else:
                                raise

                # Fallback to TTS model (CustomVoice preferred)
                if wav is None:
                    tts_model = load_tts()
                    if MODEL_TYPE.lower() == "customvoice" and hasattr(tts_model, "generate_custom_voice"):
                        wavs, out_sr = tts_model.generate_custom_voice(
                            text=text,
                            language=language,
                            speaker=speaker,
                            instruct=merged_instruct,
                            max_new_tokens=512,
                            do_sample=False,
                        )
                        wav = wavs[0]
                    else:
                        wavs, out_sr = tts_model.generate(
                            text=text,
                            language=language,
                            instruct=merged_instruct,
                        )
                        wav = wavs[0]

        if torch.is_tensor(wav):
            wav = wav.float().cpu().numpy()

        return Response(wav_bytes(out_sr or 24000, wav), media_type="audio/wav")

    except Exception as e:
        LAST_ERR = f"{type(e).__name__}: {e}"
        LAST_TB = traceback.format_exc()
        print("[qwen3] ERROR:", LAST_ERR)
        print(LAST_TB)
        return JSONResponse(status_code=500, content={"ok": False, "error": LAST_ERR})

# ---------------- Main ----------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
