import io
import os
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, Body
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

# Chatterbox
from chatterbox.tts import ChatterboxTTS

app = FastAPI(title="Chatterbox Local TTS", version="0.1")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

_model: Optional[ChatterboxTTS] = None

def _float_to_int16(wav: np.ndarray) -> np.ndarray:
    wav = np.asarray(wav, dtype=np.float32)
    wav = np.clip(wav, -1.0, 1.0)
    return (wav * 32767.0).astype(np.int16)

def _wav_bytes(sr: int, wav_float: np.ndarray) -> bytes:
    import wave

    wav_i16 = _float_to_int16(wav_float)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # int16
        wf.setframerate(sr)
        wf.writeframes(wav_i16.tobytes())
    return buf.getvalue()

class SpeechRequest(BaseModel):
    input: str
    voice: str = "default"  # for future; chatterbox core uses prompt audio instead
    # If None, Chatterbox auto-picks based on text length (because we patched tts.py)
    max_new_tokens: Optional[int] = None

    # Optional tuning (keep defaults matching your generate signature)
    repetition_penalty: float = 1.2
    min_p: float = 0.05
    top_p: float = 1.0
    audio_prompt_path: Optional[str] = None
    exaggeration: float = 0.5
    cfg_weight: float = 0.5
    temperature: float = 0.8

@app.get("/health")
def health():
    return {"ok": True, "device": DEVICE, "model_loaded": _model is not None}

@app.post("/audio/speech")
def speech(req: SpeechRequest = Body(...)):
    global _model
    try:
        text = (req.input or "").strip()
        if not text:
            return JSONResponse(status_code=400, content={"error": {"message": "Missing input text"}})

        if _model is None:
            # Load once
            _model = ChatterboxTTS.from_pretrained(DEVICE)

        wav = _model.generate(
            text=text,
            repetition_penalty=req.repetition_penalty,
            min_p=req.min_p,
            top_p=req.top_p,
            audio_prompt_path=req.audio_prompt_path,
            exaggeration=req.exaggeration,
            cfg_weight=req.cfg_weight,
            temperature=req.temperature,
            max_new_tokens=req.max_new_tokens,
        )

        wav_np = wav.squeeze(0).detach().cpu().numpy()
        audio = _wav_bytes(_model.sr, wav_np)

        return Response(content=audio, media_type="audio/wav")

    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(e), "type": "server_error"}},
        )

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CHATTERBOX_PORT", "4123"))
    host = os.environ.get("CHATTERBOX_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="info")
