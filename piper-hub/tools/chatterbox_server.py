import io
import os
import time
import traceback
import unicodedata
import re
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

# Robustness knobs
CHUNK_CHARS = int(os.environ.get("CHATTERBOX_CHUNK_CHARS", "320"))  # internal chunk size, not a user-visible clamp
GAP_MS = int(os.environ.get("CHATTERBOX_GAP_MS", "70"))             # silence between chunks
SERIALIZE = os.environ.get("CHATTERBOX_SERIALIZE", "1") != "0"      # default: one request at a time
RETRY_ON_CUDA_ERROR = int(os.environ.get("CHATTERBOX_RETRY_CUDA", "1"))  # retry once on CUDA-ish errors

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
_req_lock = threading.Lock()


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


def _sanitize_text(text: str) -> str:
    """
    Make Chatterbox resilient to odd Unicode punctuation & invisible characters.
    This is NOT a length clamp; it's normalization.
    """
    t = text or ""
    t = unicodedata.normalize("NFKC", t)

    # Replace common "smart" punctuation that can break some pipelines
    t = (t.replace("“", '"').replace("”", '"')
           .replace("‘", "'").replace("’", "'")
           .replace("—", "-").replace("–", "-")
           .replace("…", "..."))

    # Remove zero-width/invisible characters
    t = re.sub(r"[\u200B-\u200D\uFEFF]", "", t)

    # Collapse excessive whitespace
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)

    return t.strip()


_sentence_split_re = re.compile(r"(?<=[\.\!\?])\s+|\n+")


def _split_to_chunks(text: str, max_chars: int) -> List[str]:
    """
    Split text into internal chunks to avoid GPU OOM / rare tokenization edge-cases on long inputs.
    This preserves the full content (no truncation), just synthesizes in pieces and concatenates audio.
    """
    if not text:
        return []

    # Primary split by sentences / newlines
    parts = [p.strip() for p in _sentence_split_re.split(text) if p and p.strip()]
    if not parts:
        parts = [text.strip()]

    chunks: List[str] = []

    def push_buf(buf: str):
        b = buf.strip()
        if b:
            chunks.append(b)

    buf = ""
    for p in parts:
        # If a single sentence is huge, split by commas/semicolons, then by words
        if len(p) > max_chars:
            subparts = re.split(r"(?<=[,;:])\s+", p)
            for sp in subparts:
                sp = sp.strip()
                if not sp:
                    continue
                if len(sp) <= max_chars:
                    if len(buf) + len(sp) + 1 <= max_chars:
                        buf = (buf + " " + sp).strip()
                    else:
                        push_buf(buf)
                        buf = sp
                else:
                    # word-wrap the remainder
                    words = sp.split()
                    line = ""
                    for w in words:
                        if len(line) + len(w) + 1 <= max_chars:
                            line = (line + " " + w).strip()
                        else:
                            push_buf(line)
                            line = w
                    push_buf(line)
            continue

        if not buf:
            buf = p
        elif len(buf) + len(p) + 1 <= max_chars:
            buf = buf + " " + p
        else:
            push_buf(buf)
            buf = p

    push_buf(buf)
    return chunks


def _is_cuda_related_error(e: Exception) -> bool:
    msg = (repr(e) + " " + str(e)).lower()
    return any(k in msg for k in [
        "cuda", "cublas", "cudnn", "device-side assert", "out of memory", "oom",
        "illegal memory access", "misaligned address"
    ])


def _cuda_recover():
    if DEVICE != "cuda":
        return
    try:
        torch.cuda.synchronize()
    except Exception:
        pass
    try:
        torch.cuda.empty_cache()
    except Exception:
        pass


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
    return {"ok": True, "device": DEVICE, "model_loaded": _model is not None, "serialize": SERIALIZE}


@app.post("/audio/speech")
def speech(req: SpeechRequest = Body(...)):
    global _model

    # Serialize requests by default (prevents concurrent CUDA contention / racey crashes)
    lock = _req_lock if SERIALIZE else _NoopLock()

    with lock:
        text_raw = (req.input or "").strip()
        if not text_raw:
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

            # Normalize/sanitize text (no truncation)
            text = _sanitize_text(text_raw)

            # Internal chunking (no user-visible clamp)
            chunks = _split_to_chunks(text, CHUNK_CHARS)
            if not chunks:
                return JSONResponse(status_code=400, content={"error": {"message": "Empty input after sanitization"}})

            # Sample rate: prefer model sr, fallback 24000
            sr = int(getattr(_model, "sr", 24000) or 24000)
            gap = int(sr * (GAP_MS / 1000.0))
            silence = np.zeros((gap,), dtype=np.float32) if gap > 0 else None

            max_new_tokens = int(req.max_new_tokens) if req.max_new_tokens is not None else 220

            t0 = time.time()

            def gen_once(chunk_text: str):
                if DEVICE == "cuda":
                    with torch.inference_mode(), torch.cuda.amp.autocast(dtype=torch.float16):
                        return _model.generate(
                            text=chunk_text,
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
                        return _model.generate(
                            text=chunk_text,
                            repetition_penalty=req.repetition_penalty,
                            min_p=req.min_p,
                            top_p=req.top_p,
                            audio_prompt_path=prompt_path,
                            exaggeration=req.exaggeration,
                            cfg_weight=req.cfg_weight,
                            temperature=req.temperature,
                            max_new_tokens=max_new_tokens,
                        )

            wav_parts: List[np.ndarray] = []
            for i, ch in enumerate(chunks):
                # Generation per chunk with optional CUDA recovery retry
                try:
                    wav = gen_once(ch)
                except Exception as e1:
                    if RETRY_ON_CUDA_ERROR and _is_cuda_related_error(e1):
                        print(f"[chatterbox] chunk {i+1}/{len(chunks)} CUDA-ish error; recovering and retrying once: {repr(e1)}")
                        _cuda_recover()
                        wav = gen_once(ch)
                    else:
                        raise

                wav_np = _sanitize_wav(wav)
                wav_parts.append(wav_np)
                if silence is not None and i != len(chunks) - 1:
                    wav_parts.append(silence)

            wav_full = np.concatenate(wav_parts, axis=0)

            # Encode wav (wave first, then soundfile fallback)
            try:
                audio = _wav_bytes_wave(sr, wav_full)
            except Exception as e_wave:
                # Fallback to soundfile if wave writer hits a platform edge-case
                print("[chatterbox] wave encode failed, falling back:", repr(e_wave))
                audio = _wav_bytes_soundfile(sr, wav_full)

            dt_ms = int((time.time() - t0) * 1000.0)
            total_chars = sum(len(c) for c in chunks)
            print(
                f"[chatterbox] generated in {dt_ms} ms | sr={sr} | chunks={len(chunks)} | chars={total_chars} "
                f"| tokens={max_new_tokens} | device={DEVICE}"
            )

            return Response(content=audio, media_type="audio/wav")

        except Exception as e:
            # Print full traceback to console so we can see the *real* source of 500s
            print("[chatterbox] ERROR:", repr(e))
            traceback.print_exc()

            # Best-effort CUDA recovery so the next request can succeed
            if DEVICE == "cuda" and _is_cuda_related_error(e):
                print("[chatterbox] attempting CUDA recovery after error...")
                _cuda_recover()

            return JSONResponse(
                status_code=500,
                content={"error": {"message": str(e), "type": "server_error"}},
            )


class _NoopLock:
    def __enter__(self): 
        return self
    def __exit__(self, exc_type, exc, tb):
        return False


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CHATTERBOX_PORT", "4123"))
    host = os.environ.get("CHATTERBOX_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="info")
