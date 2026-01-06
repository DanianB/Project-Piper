import io
import os
import time
import traceback
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, Body
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

from chatterbox.tts import ChatterboxTTS

app = FastAPI(title="Chatterbox Local TTS", version="0.3")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DEFAULT_PROMPT_WAV = os.environ.get("CHATTERBOX_PROMPT_WAV")
LOG_PROMPT = os.environ.get("CHATTERBOX_LOG_PROMPT") == "1"

# Speed knobs (safe)
if DEVICE == "cuda":
    try:
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        torch.set_float32_matmul_precision("high")
    except Exception:
        pass

_model: Optional[ChatterboxTTS] = None


def _sanitize_wav(wav) -> np.ndarray:
    """
    Make sure we always return a 1D float32 numpy array with finite values.
    """
    # Tensor -> CPU numpy
    if torch.is_tensor(wav):
        wav = wav.detach().float().cpu().numpy()

    wav = np.asarray(wav, dtype=np.float32)

    # Common shapes: (T,), (1,T), (T,1), (B,T)
    if wav.ndim == 2:
        # If it's (1, T) or (T, 1), squeeze to (T,)
        if 1 in wav.shape:
            wav = wav.squeeze()
        else:
            # If it's (B, T), take first row
            wav = wav[0]
    elif wav.ndim > 2:
        wav = np.squeeze(wav)

    # Ensure 1D
    wav = wav.reshape(-1)

    # Replace NaN/Inf with 0 and clamp
    wav = np.nan_to_num(wav, nan=0.0, posinf=0.0, neginf=0.0)
    wav = np.clip(wav, -1.0, 1.0)

    # Avoid empty output
    if wav.size < 8:
        raise ValueError(f"Generated waveform too short/empty (len={wav.size}).")

    return wav


def _wav_bytes_wave(sr: int, wav_float: np.ndarray) -> bytes:
    """
    Write WAV using Python's wave module into memory.
    """
    import wave

    if not isinstance(sr, int):
        sr = int(sr)
    if sr <= 0:
        raise ValueError(f"Invalid sample rate: {sr}")

    wav_i16 = (wav_float * 32767.0).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # int16
        wf.setframerate(sr)
        wf.writeframes(wav_i16.tobytes())
    return buf.getvalue()


def _wav_bytes_soundfile(sr: int, wav_float: np.ndarray) -> bytes:
    """
    Fallback writer using soundfile if available.
    """
    import soundfile as sf

    if not isinstance(sr, int):
        sr = int(sr)
    if sr <= 0:
        raise ValueError(f"Invalid sample rate: {sr}")

    buf = io.BytesIO()
    sf.write(buf, wav_float, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class SpeechRequest(BaseModel):
    input: str
    voice: str = "default"

    max_new_tokens: Optional[int] = None

    repetition_penalty: float = 1.2
    min_p: float = 0.05
    top_p: float = 1.0

    audio_prompt_path: Optional[str] = None
    exaggeration: float = 0.5
    cfg_weight: float = 0.35
    temperature: float = 0.8


@app.get("/health")
def health():
    return {"ok": True, "device": DEVICE, "model_loaded": _model is not None}


@app.post("/audio/speech")
def speech(req: SpeechRequest = Body(...)):
    global _model

    text = (req.input or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"error": {"message": "Missing input text"}})

    try:
        if _model is None:
            _model = ChatterboxTTS.from_pretrained(DEVICE)

        # Pick prompt: request override > env default
        prompt_path = req.audio_prompt_path or DEFAULT_PROMPT_WAV
        if prompt_path:
            if not os.path.exists(prompt_path):
                return JSONResponse(
                    status_code=400,
                    content={"error": {"message": f"audio_prompt_path not found: {prompt_path}"}},
                )
            if LOG_PROMPT:
                print(f"[chatterbox] prompt={prompt_path}")

        max_new_tokens = int(req.max_new_tokens) if req.max_new_tokens is not None else 220

        t0 = time.time()

        if DEVICE == "cuda":
            with torch.inference_mode(), torch.cuda.amp.autocast(dtype=torch.float16):
                wav = _model.generate(
                    text=text,
                    repetition_penalty=req.repetition_penalty,
                    min_p=req.min_p,
                    top_p=req.top_p,
                    audio_prompt_path=prompt_path,
                    exaggeration=req.exaggeration,
                    cfg_weight=req.cfg_weight,
                    temperature=req.temperature,
                    max_new_tokens=max_new_tokens,
                )
        else:
            with torch.inference_mode():
                wav = _model.generate(
                    text=text,
                    repetition_penalty=req.repetition_penalty,
                    min_p=req.min_p,
                    top_p=req.top_p,
                    audio_prompt_path=prompt_path,
                    exaggeration=req.exaggeration,
                    cfg_weight=req.cfg_weight,
                    temperature=req.temperature,
                    max_new_tokens=max_new_tokens,
                )

        wav_np = _sanitize_wav(wav)

        # Sample rate: prefer model sr, fallback 24000
        sr = int(getattr(_model, "sr", 24000) or 24000)

        # Encode wav (wave first, then soundfile fallback)
        try:
            audio = _wav_bytes_wave(sr, wav_np)
        except Exception as e_wave:
            # Fallback to soundfile if wave writer hits a platform edge-case
            print("[chatterbox] wave encode failed, falling back:", repr(e_wave))
            audio = _wav_bytes_soundfile(sr, wav_np)

        dt_ms = int((time.time() - t0) * 1000.0)
        print(f"[chatterbox] generated in {dt_ms} ms | sr={sr} | tokens={max_new_tokens} | device={DEVICE}")

        return Response(content=audio, media_type="audio/wav")

    except Exception as e:
        # Print full traceback to console so we can see the *real* source of Errno 22
        print("[chatterbox] ERROR:", repr(e))
        traceback.print_exc()

        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(e), "type": "server_error"}},
        )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CHATTERBOX_PORT", "4123"))
    host = os.environ.get("CHATTERBOX_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="info")
