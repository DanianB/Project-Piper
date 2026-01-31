"""
Qwen3-TTS local microservice for Piper (dual-model + clone w/o SoX + warmup).

Key points:
- CustomVoice model does NOT support generate_voice_clone().
- Use a clone-capable model (default: Base) when ref_audio is present / imitation selected.
- Decode reference audio with ffmpeg into numpy to avoid SoX dependency.
- Provide /warmup to load both models proactively (prevents first-speak timeouts).

Env:
- QWEN3_MODEL_TYPE / QWEN3_MODEL_SIZE (normal TTS)  default: CustomVoice / 0.6B
- QWEN3_CLONE_MODEL_TYPE / QWEN3_CLONE_MODEL_SIZE (clone) default: Base / 0.6B
- QWEN3_DEFAULT_REF_AUDIO (e.g. E:\\AI\\Voice\\voice.mp3)
- QWEN3_FFMPEG_EXE (path to ffmpeg.exe) or ffmpeg on PATH
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

HOST = os.environ.get("QWEN3_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN3_PORT", "5005"))

DEVICE = os.environ.get("QWEN3_DEVICE", "cuda").lower()
CUDA_INDEX = int(os.environ.get("QWEN3_CUDA_INDEX", "0"))

MODEL_TYPE = os.environ.get("QWEN3_MODEL_TYPE", "CustomVoice")
MODEL_SIZE = os.environ.get("QWEN3_MODEL_SIZE", "0.6B")

CLONE_MODEL_TYPE = os.environ.get("QWEN3_CLONE_MODEL_TYPE", "Base")
CLONE_MODEL_SIZE = os.environ.get("QWEN3_CLONE_MODEL_SIZE", "0.6B")

DTYPE_ENV = os.environ.get("QWEN3_DTYPE", "float32").lower()
ATTN = os.environ.get("QWEN3_ATTN", "eager")
DTYPE = torch.float16 if DTYPE_ENV in ("float16", "fp16") else torch.float32

DEFAULT_REF_AUDIO = os.environ.get("QWEN3_DEFAULT_REF_AUDIO", "").strip()
FFMPEG_EXE = os.environ.get("QWEN3_FFMPEG_EXE", "").strip() or "ffmpeg"


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

try:
    from qwen_tts import Qwen3TTSModel
except Exception as e:
    Qwen3TTSModel = None
    IMPORT_ERR = e
else:
    IMPORT_ERR = None


app = FastAPI(title="Qwen3-TTS")

_model_tts: Optional["Qwen3TTSModel"] = None
_model_clone: Optional["Qwen3TTSModel"] = None

LOAD_ERROR_TTS: Optional[str] = None
LOAD_ERROR_CLONE: Optional[str] = None

INFER_LOCK = threading.Lock()
LAST_ERR: Optional[str] = None
LAST_TB: Optional[str] = None


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


class SpeakReq(BaseModel):
    text: str
    voice: str = "ryan"
    language: str = "english"
    instruct: str = "Neutral."
    ref_audio: Optional[str] = None
    voice_id: Optional[str] = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "device": DEVICE,
        "dtype": str(DTYPE),
        "tts_model_id": _mid(MODEL_SIZE, MODEL_TYPE),
        "clone_model_id": _mid(CLONE_MODEL_SIZE, CLONE_MODEL_TYPE),
        "tts_loaded": _model_tts is not None,
        "clone_loaded": _model_clone is not None,
        "load_error_tts": LOAD_ERROR_TTS,
        "load_error_clone": LOAD_ERROR_CLONE,
        "default_ref_audio": DEFAULT_REF_AUDIO,
        "ffmpeg": FFMPEG_EXE,
    }


@app.get("/capabilities")
def capabilities():
    return {"ok": True, "tts_model_id": _mid(MODEL_SIZE, MODEL_TYPE), "clone_model_id": _mid(CLONE_MODEL_SIZE, CLONE_MODEL_TYPE)}


@app.get("/warmup")
def warmup():
    # Load both models so the first speak doesn't stall.
    try:
        load_tts()
        load_clone()
        return {"ok": True, "tts_loaded": True, "clone_loaded": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e), "traceback": traceback.format_exc()})


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
    voice_id = (req.voice_id or "").strip()

    if not ref_audio and raw_voice == "imitation" and DEFAULT_REF_AUDIO:
        ref_audio = DEFAULT_REF_AUDIO

    print(f"[qwen3] /speak voice='{raw_voice}' ref_audio='{ref_audio}' voice_id='{voice_id}' text_len={len(text)}")

    speaker = raw_voice
    if speaker in ("default_female", "default-female", "female", "custom", "imitation"):
        speaker = "vivian"

    try:
        wants_clone = bool(ref_audio)

        with INFER_LOCK, torch.inference_mode():
            if wants_clone:
                clone_model = load_clone()
                if not hasattr(clone_model, "generate_voice_clone"):
                    return JSONResponse(status_code=500, content={"ok": False, "error": "clone model has no generate_voice_clone()"})

                audio_np, sr = decode_ref_audio_to_numpy(ref_audio, target_sr=24000)

                wavs, out_sr = clone_model.generate_voice_clone(
                    text=text,
                    language=language,
                    ref_audio=(audio_np, sr),
                    x_vector_only_mode=True,
                    non_streaming_mode=True,
                )
                wav = wavs[0]
            else:
                tts_model = load_tts()
                if MODEL_TYPE.lower() == "customvoice" and hasattr(tts_model, "generate_custom_voice"):
                    wavs, out_sr = tts_model.generate_custom_voice(text=text, language=language, speaker=speaker, instruct=instruct)
                    wav = wavs[0]
                else:
                    wavs, out_sr = tts_model.generate(text=text, language=language, instruct=instruct)
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
