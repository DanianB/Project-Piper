import io
import os
import time
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, Body
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

# Chatterbox (this matches your env)
from chatterbox.tts import ChatterboxTTS

app = FastAPI(title="Chatterbox Local TTS", version="0.2")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DEFAULT_PROMPT_WAV = os.environ.get("CHATTERBOX_PROMPT_WAV")  # <-- your Piper voice lives here
LOG_PROMPT = os.environ.get("CHATTERBOX_LOG_PROMPT") == "1"

# Speed knobs (safe defaults)
if DEVICE == "cuda":
    try:
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        torch.set_float32_matmul_precision("high")
    except Exception:
        pass

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
    return {
        "ok": True,
        "device": DEVICE,
        "model_loaded": _model is not None,
    }


@app.post("/audio/speech")
def speech(req: SpeechRequest = Body(...)):
    global _model
    try:
        text = (req.input or "").strip()
        if not text:
            return JSONResponse(status_code=400, content={"error": {"message": "Missing input text"}})

        if _model is None:
            _model = ChatterboxTTS.from_pretrained(DEVICE)

        # Choose prompt: request override > env default
        prompt_path = req.audio_prompt_path or DEFAULT_PROMPT_WAV
        if prompt_path and not os.path.exists(prompt_path):
            return JSONResponse(
                status_code=400,
                content={"error": {"message": f"audio_prompt_path not found: {prompt_path}"}},
            )
        if LOG_PROMPT:
            print(f"[chatterbox] prompt={prompt_path}")

        # Token default if not provided
        max_new_tokens = int(req.max_new_tokens) if req.max_new_tokens is not None else 200

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

        dt = (time.time() - t0) * 1000.0
        print(f"[chatterbox] generated in {dt:.0f} ms | tokens={max_new_tokens} | device={DEVICE}")

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
