import io
import os
import re
import time
import traceback
import unicodedata
import threading
from typing import Optional, List, Tuple

import numpy as np
import torch
from fastapi import FastAPI, Body
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

from chatterbox.tts import ChatterboxTTS

app = FastAPI(title="Chatterbox Local TTS", version="0.4")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DEFAULT_PROMPT_WAV = os.environ.get("CHATTERBOX_PROMPT_WAV")
LOG_PROMPT = os.environ.get("CHATTERBOX_LOG_PROMPT") == "1"

# Chunking / stability knobs (does NOT truncate overall speech; it synthesizes in pieces)
CHUNK_CHARS = int(os.environ.get("CHATTERBOX_CHUNK_CHARS", "320"))
GAP_MS = int(os.environ.get("CHATTERBOX_GAP_MS", "70"))
SERIALIZE = os.environ.get("CHATTERBOX_SERIALIZE", "1") != "0"
RETRY_CUDA = os.environ.get("CHATTERBOX_RETRY_CUDA", "1") != "0"

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
_lock = threading.Lock()


def _normalize_text(s: str) -> str:
    """Normalize unicode and remove problematic control characters."""
    s = unicodedata.normalize("NFKC", s or "")
    # Replace smart quotes/dashes that sometimes cause tokenizer edge cases
    s = s.replace("\u2019", "'").replace("\u2018", "'")
    s = s.replace("\u201c", '"').replace("\u201d", '"')
    s = s.replace("\u2014", "-").replace("\u2013", "-")
    # Remove control chars except \n and \t
    s = "".join(ch for ch in s if ch == "\n" or ch == "\t" or ord(ch) >= 32)
    # Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()
    return s


_SENT_SPLIT = re.compile(r"(?<=[\.\!\?])\s+")


def _chunk_text(text: str, max_chars: int) -> List[str]:
    """Split text into safe chunks. Keeps total content; no truncation."""
    text = _normalize_text(text)
    if len(text) <= max_chars:
        return [text]

    parts: List[str] = []
    sentences = _SENT_SPLIT.split(text)
    cur = ""
    for sent in sentences:
        sent = sent.strip()
        if not sent:
            continue
        if len(sent) > max_chars:
            # Hard split very long sentence
            for i in range(0, len(sent), max_chars):
                parts.append(sent[i : i + max_chars].strip())
            continue

        if not cur:
            cur = sent
            continue

        if len(cur) + 1 + len(sent) <= max_chars:
            cur = f"{cur} {sent}"
        else:
            parts.append(cur)
            cur = sent

    if cur:
        parts.append(cur)

    return [p for p in parts if p]


def _sanitize_wav(wav) -> np.ndarray:
    """
    Make sure we always return a 1D float32 numpy array with finite values.
    """
    if torch.is_tensor(wav):
        wav = wav.detach().float().cpu().numpy()

    wav = np.asarray(wav, dtype=np.float32)

    if wav.ndim == 2:
        if 1 in wav.shape:
            wav = wav.squeeze()
        else:
            wav = wav[0]
    elif wav.ndim > 2:
        wav = np.squeeze(wav)

    wav = wav.reshape(-1)
    wav = np.nan_to_num(wav, nan=0.0, posinf=0.0, neginf=0.0)
    wav = np.clip(wav, -1.0, 1.0)

    if wav.size < 8:
        raise ValueError(f"Generated waveform too short/empty (len={wav.size}).")

    return wav


def _wav_bytes_wave(sr: int, wav_float: np.ndarray) -> bytes:
    import wave

    sr = int(sr)
    if sr <= 0:
        raise ValueError(f"Invalid sample rate: {sr}")

    wav_i16 = (wav_float * 32767.0).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(wav_i16.tobytes())
    return buf.getvalue()


def _silence(sr: int, ms: int) -> np.ndarray:
    n = int(sr * (ms / 1000.0))
    if n <= 0:
        return np.zeros((0,), dtype=np.float32)
    return np.zeros((n,), dtype=np.float32)


def _is_cudaish_error(e: Exception) -> bool:
    msg = str(e).lower()
    return (
        "cuda" in msg
        or "cudnn" in msg
        or "illegal memory access" in msg
        or "device-side assert" in msg
        or "out of memory" in msg
    )


def _load_model() -> ChatterboxTTS:
    global _model
    if _model is None:
        _model = ChatterboxTTS.from_pretrained(DEVICE)
    return _model


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

    def _run_once() -> Tuple[int, bytes, dict]:
        model = _load_model()

        prompt_path = req.audio_prompt_path or DEFAULT_PROMPT_WAV
        if prompt_path:
            if not os.path.exists(prompt_path):
                return 0, b"", {"status": 400, "message": f"audio_prompt_path not found: {prompt_path}"}
            if LOG_PROMPT:
                print(f"[chatterbox] prompt={prompt_path}")

        max_new_tokens = int(req.max_new_tokens) if req.max_new_tokens is not None else 220

        t0 = time.time()
        chunks = _chunk_text(text, CHUNK_CHARS)

        sr = int(getattr(model, "sr", 24000) or 24000)
        gap = _silence(sr, GAP_MS)

        wavs: List[np.ndarray] = []
        for i, chunk in enumerate(chunks):
            if DEVICE == "cuda":
                with torch.inference_mode(), torch.cuda.amp.autocast(dtype=torch.float16):
                    w = model.generate(
                        text=chunk,
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
                    w = model.generate(
                        text=chunk,
                        repetition_penalty=req.repetition_penalty,
                        min_p=req.min_p,
                        top_p=req.top_p,
                        audio_prompt_path=prompt_path,
                        exaggeration=req.exaggeration,
                        cfg_weight=req.cfg_weight,
                        temperature=req.temperature,
                        max_new_tokens=max_new_tokens,
                    )

            w_np = _sanitize_wav(w)
            wavs.append(w_np)
            if i != len(chunks) - 1 and gap.size:
                wavs.append(gap)

        full = np.concatenate(wavs) if len(wavs) > 1 else wavs[0]
        audio = _wav_bytes_wave(sr, full)

        dt_ms = int((time.time() - t0) * 1000.0)
        meta = {"ms": dt_ms, "sr": sr, "tokens": max_new_tokens, "chunks": len(chunks), "chars": len(text), "device": DEVICE}
        return sr, audio, meta

    try:
        # Optionally serialize requests for CUDA stability
        if SERIALIZE:
            with _lock:
                sr, audio, meta = _run_once()
        else:
            sr, audio, meta = _run_once()

        if not audio:
            return JSONResponse(status_code=500, content={"error": {"message": "Empty audio output"}})

        print(f"[chatterbox] generated in {meta['ms']} ms | sr={meta['sr']} | chunks={meta['chunks']} | chars={meta['chars']} | tokens={meta['tokens']} | device={meta['device']}")
        return Response(content=audio, media_type="audio/wav")

    except Exception as e:
        # Try one CUDA recovery retry if enabled
        if DEVICE == "cuda" and RETRY_CUDA and _is_cudaish_error(e):
            print("[chatterbox] CUDA-ish error; attempting recovery + retry:", repr(e))
            try:
                torch.cuda.empty_cache()
                # Recreate model (some CUDA errors poison the process state)
                _model = None
                if SERIALIZE:
                    with _lock:
                        sr, audio, meta = _run_once()
                else:
                    sr, audio, meta = _run_once()
                print(f"[chatterbox] retry ok in {meta['ms']} ms | sr={meta['sr']} | chunks={meta['chunks']} | chars={meta['chars']}")
                return Response(content=audio, media_type="audio/wav")
            except Exception as e2:
                print("[chatterbox] retry failed:", repr(e2))
                traceback.print_exc()

        print("[chatterbox] ERROR:", repr(e))
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": {"message": str(e), "type": "server_error"}})


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CHATTERBOX_PORT", "4123"))
    host = os.environ.get("CHATTERBOX_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="info")
