"""
Qwen3-TTS local microservice for Piper (stable baseline + inspected imitation adapter).

- CUDA only (no silent CPU fallback)
- Clear error reporting
- Mode mapping (default/custom/imitation)
- Imitation implementation attempts ONLY when model exposes a known method
- Signature-based argument wiring (no blind guessing)
- Debug endpoints to inspect model capabilities on your machine
"""

import io
import os
import traceback
import threading
import inspect
from typing import Optional, Any, Dict, List, Tuple

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

DTYPE_ENV = os.environ.get("QWEN3_DTYPE", "float32").lower()
ATTN = os.environ.get("QWEN3_ATTN", "eager")

if DTYPE_ENV in ("float16", "fp16"):
    DTYPE = torch.float16
else:
    DTYPE = torch.float32


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


# ---------------- Globals ----------------

app = FastAPI(title="Qwen3-TTS")

_model: Optional["Qwen3TTSModel"] = None
LOAD_ERROR: Optional[str] = None

INFER_LOCK = threading.Lock()

LAST_ERR: Optional[str] = None
LAST_TB: Optional[str] = None


# ---------------- Helpers ----------------

def model_id():
    return f"Qwen/Qwen3-TTS-12Hz-{MODEL_SIZE}-{MODEL_TYPE}"


def device_map():
    if DEVICE != "cuda":
        raise RuntimeError("QWEN3_DEVICE must be 'cuda' (CPU fallback disabled).")

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA not available (torch.cuda.is_available() is False).")

    return f"cuda:{CUDA_INDEX}"


def load_model():

    global _model, LOAD_ERROR, LAST_ERR, LAST_TB

    if _model is not None:
        return _model

    if LOAD_ERROR:
        raise RuntimeError(LOAD_ERROR)

    if Qwen3TTSModel is None:
        raise RuntimeError(f"Import failed: {IMPORT_ERR}")

    mid = model_id()
    dmap = device_map()

    print(f"[qwen3] Loading {mid} | {dmap} | {DTYPE}")

    try:
        _model = Qwen3TTSModel.from_pretrained(
            mid,
            device_map=dmap,
            dtype=DTYPE,
            attn_implementation=ATTN,
        )

        print("[qwen3] Model ready")
        return _model

    except Exception as e:
        LAST_ERR = f"{type(e).__name__}: {e}"
        LAST_TB = traceback.format_exc()
        LOAD_ERROR = LAST_ERR

        print("[qwen3] LOAD ERROR:")
        print(LAST_ERR)
        print(LAST_TB)

        raise


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


def load_wav_mono_float32(path: str) -> Tuple[np.ndarray, int]:
    """Load PCM WAV (8/16/24/32-bit int or 32-bit float) via stdlib wave.
    Returns mono float32 in [-1,1], sample_rate.
    """
    import wave
    with wave.open(path, "rb") as wf:
        nch = wf.getnchannels()
        sr = wf.getframerate()
        sampwidth = wf.getsampwidth()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)

    if sampwidth == 1:
        x = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        x = (x - 128.0) / 128.0
    elif sampwidth == 2:
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 3:
        # 24-bit little endian -> int32 with sign extension
        a = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        v = (a[:, 0].astype(np.int32) |
             (a[:, 1].astype(np.int32) << 8) |
             (a[:, 2].astype(np.int32) << 16))
        mask = v & 0x800000
        v = v - (mask << 1)
        x = v.astype(np.float32) / 8388608.0
    elif sampwidth == 4:
        # could be int32 or float32; wave doesn't tell.
        # assume int32 unless values look like floats.
        as_i = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
        # heuristic: if many NaNs when interpreted as float, use int; else float
        as_f = np.frombuffer(raw, dtype=np.float32)
        if np.isnan(as_f).mean() < 0.001:
            x = as_f.astype(np.float32)
        else:
            x = as_i
    else:
        raise RuntimeError(f"Unsupported WAV sample width: {sampwidth}")

    if nch > 1:
        x = x.reshape(-1, nch).mean(axis=1)

    x = np.clip(x, -1.0, 1.0).astype(np.float32)
    return x, int(sr)


# ---------------- Imitation wiring (signature based) ----------------

IMITATION_METHOD_CANDIDATES = [
    "generate_with_reference",
    "generate_with_ref_audio",
    "generate_voice_clone",
    "clone_voice",
    "create_voice",
]

def _find_imitation_method(model) -> Optional[str]:
    if model is None:
        return None
    for name in IMITATION_METHOD_CANDIDATES:
        if hasattr(model, name):
            return name
    return None

def imitation_supported(model) -> bool:
    return _find_imitation_method(model) is not None

def _call_with_signature(fn, candidate_kwargs: Dict[str, Any]) -> Any:
    sig = inspect.signature(fn)
    accepted = {}
    for k, v in candidate_kwargs.items():
        if k in sig.parameters:
            accepted[k] = v
    # if function accepts **kwargs, pass everything
    has_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    if has_varkw:
        accepted = dict(candidate_kwargs)
    return fn(**accepted)

def _prepare_ref_inputs(ref_audio_path: str) -> Dict[str, Any]:
    # Provide both path and decoded audio so we can match whatever the signature wants.
    wav, sr = load_wav_mono_float32(ref_audio_path)
    return {
        "ref_audio": wav,
        "ref_wav": wav,
        "reference_audio": wav,
        "reference_wav": wav,
        "ref_sr": sr,
        "reference_sr": sr,
        "ref_audio_path": ref_audio_path,
        "ref_path": ref_audio_path,
        "reference_path": ref_audio_path,
        "ref_file": ref_audio_path,
    }


# ---------------- API ----------------

class SpeakReq(BaseModel):
    text: str
    voice: str = "ryan"
    language: str = "english"
    instruct: str = "Neutral."

    ref_audio: Optional[str] = None   # file path (from Piper Hub upload)
    voice_id: Optional[str] = None    # optional id for caching / reuse (if supported)


@app.get("/health")
def health():
    return {
        "ok": True,
        "device": DEVICE,
        "dtype": str(DTYPE),
        "model_loaded": _model is not None,
        "load_error": LOAD_ERROR,
    }


@app.get("/capabilities")
def capabilities():
    try:
        m = _find_imitation_method(_model)
        return {
            "ok": True,
            "imitation_supported": m is not None,
            "imitation_method": m,
        }
    except Exception as e:
        return {
            "ok": False,
            "imitation_supported": False,
            "error": str(e),
        }


@app.get("/debug/model_methods")
def debug_model_methods(load: bool = False):
    """Return a filtered list of model methods/attrs to inspect capabilities.
    Set load=true to force-load model (can take time).
    """
    try:
        model = load_model() if load else _model
        if model is None:
            return JSONResponse(
                status_code=200,
                content={"ok": True, "loaded": False, "methods": [], "note": "model not loaded"},
            )

        names = sorted(set(dir(model)))
        keep = []
        for n in names:
            nl = n.lower()
            if any(k in nl for k in ("ref", "clone", "voice", "speaker", "embed", "reference")):
                keep.append(n)

        # also include our candidate methods even if they don't match filter
        for n in IMITATION_METHOD_CANDIDATES:
            if hasattr(model, n) and n not in keep:
                keep.append(n)

        keep = sorted(set(keep))
        return {"ok": True, "loaded": True, "methods": keep}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


@app.get("/debug/imitation_signature")
def debug_imitation_signature(load: bool = False):
    """Return signature for the detected imitation method (if present)."""
    try:
        model = load_model() if load else _model
        if model is None:
            return {"ok": True, "loaded": False, "method": None, "signature": None}

        mname = _find_imitation_method(model)
        if not mname:
            return {"ok": True, "loaded": True, "method": None, "signature": None}

        fn = getattr(model, mname)
        sig = str(inspect.signature(fn))
        return {"ok": True, "loaded": True, "method": mname, "signature": sig}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


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

    # Mode mapping
    speaker = raw_voice
    if speaker in ("default_female", "default-female", "female"):
        speaker = "vivian"
    elif speaker == "custom":
        speaker = "vivian"
    elif speaker in ("imitation", "clone", "voice_clone", "voice-clone"):
        speaker = "vivian"

    ref_audio_path = (req.ref_audio or "").strip()
    wants_imitation = bool(ref_audio_path or (req.voice_id and req.voice_id.strip()))

    try:
        model = load_model()

        with INFER_LOCK, torch.inference_mode():

            if wants_imitation:
                mname = _find_imitation_method(model)
                if not mname:
                    return JSONResponse(
                        status_code=400,
                        content={
                            "ok": False,
                            "error": "Imitation requested but model does not expose a known imitation method.",
                            "imitation_supported": False,
                        },
                    )

                if ref_audio_path and not os.path.exists(ref_audio_path):
                    return JSONResponse(
                        status_code=400,
                        content={"ok": False, "error": f"ref_audio path does not exist: {ref_audio_path}"},
                    )

                fn = getattr(model, mname)

                candidate_kwargs: Dict[str, Any] = {
                    "text": text,
                    "language": language,
                    "speaker": speaker,
                    "voice": speaker,
                    "instruct": instruct,
                    "prompt": instruct,
                    "voice_id": (req.voice_id or "").strip() or None,
                }

                if ref_audio_path:
                    candidate_kwargs.update(_prepare_ref_inputs(ref_audio_path))

                try:
                    out = _call_with_signature(fn, candidate_kwargs)
                except TypeError as te:
                    # signature mismatch — report clearly
                    return JSONResponse(
                        status_code=500,
                        content={
                            "ok": False,
                            "error": f"Imitation call signature mismatch for {mname}: {te}",
                            "method": mname,
                            "signature": str(inspect.signature(fn)),
                        },
                    )

                # Normalize output: expect (wavs, sr) like other methods
                if isinstance(out, tuple) and len(out) == 2:
                    wavs, sr = out
                else:
                    # Some APIs might return just wavs; assume 24k
                    wavs, sr = out, 24000

            else:
                if MODEL_TYPE.lower() == "customvoice":
                    wavs, sr = model.generate_custom_voice(
                        text=text,
                        language=language,
                        speaker=speaker,
                        instruct=instruct,
                    )
                else:
                    wavs, sr = model.generate(
                        text=text,
                        language=language,
                        instruct=instruct,
                    )

            wav = wavs[0] if isinstance(wavs, (list, tuple)) else wavs

        if torch.is_tensor(wav):
            wav = wav.float().cpu().numpy()

        audio = wav_bytes(sr or 24000, wav)
        return Response(audio, media_type="audio/wav")

    except Exception as e:
        LAST_ERR = str(e)
        LAST_TB = traceback.format_exc()

        print("[qwen3] ERROR:")
        print(LAST_ERR)
        print(LAST_TB)

        return JSONResponse(status_code=500, content={"ok": False, "error": LAST_ERR})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
