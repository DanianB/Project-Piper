#!/usr/bin/env python
# XTTS local HTTP server for Piper Hub (Flask)
# - Loads model ONCE (optionally eager-loads in background)
# - Exposes /health and /speak
# Env:
#   XTTS_MODEL_DIR   -> folder containing best_model.pth + config.json (+ optionally vocab.json)
#   XTTS_REFS_DIR    -> folder containing reference wavs (emotion conditioning)
#   XTTS_PORT        -> port (default 5055)
#   XTTS_DEVICE      -> "cuda" (default if available) or "cpu"
#   XTTS_FP16        -> "1" to half() on CUDA (default 1), "0" to keep fp32
#   XTTS_EAGER_LOAD  -> "1" (default) eager-load at startup, "0" load on first request
#   XTTS_NUM_THREADS -> torch CPU threads (default 1)
#
# NOTE: This server is intentionally small and self-contained.

import os
import sys
import time
import json
import threading
from pathlib import Path
from contextlib import nullcontext

try:
    from flask import Flask, jsonify, request, Response
except Exception as e:
    print("ERROR: Flask is required for xtts_server.py. Install it in the XTTS venv:", file=sys.stderr)
    print("  pip install flask", file=sys.stderr)
    raise

import torch

# Optional performance toggles
try:
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
except Exception:
    pass


# Coqui TTS
from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import Xtts


APP = Flask(__name__)

MODEL = None
MODEL_LOCK = threading.Lock()
LOAD_ERROR = None
LOADING = False
LOADED_AT = None

def _env(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return v if v is not None and str(v).strip() != "" else default

def _as_bool(v: str, default: bool = False) -> bool:
    if v is None:
        return default
    v = str(v).strip().lower()
    if v in ("1", "true", "yes", "y", "on"):
        return True
    if v in ("0", "false", "no", "n", "off"):
        return False
    return default

def pick_device() -> str:
    forced = _env("XTTS_DEVICE", "")
    if forced:
        return forced
    return "cuda" if torch.cuda.is_available() else "cpu"

def model_paths(model_dir: Path):
    # prefer best_model.pth; fall back to any best_model_*.pth
    best = model_dir / "best_model.pth"
    if best.exists():
        model_path = best
    else:
        cands = sorted(model_dir.glob("best_model_*.pth"), key=lambda p: p.stat().st_mtime, reverse=True)
        model_path = cands[0] if cands else None
    config_path = model_dir / "config.json"
    vocab_path = model_dir / "vocab.json"  # optional
    return model_path, config_path, vocab_path

def load_model_if_needed():
    global MODEL, LOAD_ERROR, LOADING, LOADED_AT

    with MODEL_LOCK:
        if MODEL is not None:
            return True
        if LOADING:
            return False
        LOADING = True
        LOAD_ERROR = None

    try:
        model_dir = Path(_env("XTTS_MODEL_DIR", "")).expanduser().resolve()
        if not model_dir.exists():
            raise RuntimeError(f"XTTS_MODEL_DIR does not exist: {model_dir}")

        model_path, config_path, vocab_path = model_paths(model_dir)
        if model_path is None or not model_path.exists():
            raise RuntimeError(f"No best_model found in: {model_dir}")
        if not config_path.exists():
            raise RuntimeError(f"Missing config.json in: {model_dir}")

        device = pick_device()
        fp16 = _as_bool(_env("XTTS_FP16", "0"), False)

        # Keep CPU usage sane during load
        try:
            torch.set_num_threads(int(_env("XTTS_NUM_THREADS", "1")))
        except Exception:
            pass

        # Log the important bits early (helps diagnose "why so slow")
        print(f"[XTTS] Loading model...", flush=True)
        print(f"[XTTS] model_dir:  {model_dir}", flush=True)
        print(f"[XTTS] model_path: {model_path}", flush=True)
        print(f"[XTTS] device:     {device} (cuda_available={torch.cuda.is_available()})", flush=True)
        print(f"[XTTS] fp16:       {fp16}", flush=True)

        cfg = XttsConfig()
        cfg.load_json(str(config_path))
        m = Xtts.init_from_config(cfg)

        # Important: load checkpoint BEFORE moving/half-ing
        m.load_checkpoint(cfg, checkpoint_path=str(model_path), vocab_path=str(vocab_path) if vocab_path.exists() else None, use_deepspeed=False)

        m.eval()
        if device.startswith("cuda"):
            m = m.to(device)
            # Keep weights in fp32 for stability; use autocast in /speak when XTTS_FP16=1.

        # warmup (tiny) to force kernels / avoid first-request hitch
        try:
            with torch.inference_mode():
                torch.zeros((1, 80, 10), device=device if device.startswith("cuda") else "cpu")
        except Exception:
            pass

        with MODEL_LOCK:
            MODEL = m
            LOADED_AT = time.time()
            LOADING = False

        print(f"[XTTS] Loaded OK", flush=True)
        return True

    except Exception as e:
        with MODEL_LOCK:
            LOAD_ERROR = str(e)
            LOADING = False
        print("[XTTS] ERROR loading model:", file=sys.stderr, flush=True)
        print(str(e), file=sys.stderr, flush=True)
        return False

def ensure_loaded_or_503():
    ok = load_model_if_needed()
    if ok:
        return True, None
    # if still loading, return 503 with status
    with MODEL_LOCK:
        err = LOAD_ERROR
        loading = LOADING
    if err:
        return False, (jsonify({"ok": False, "loading": False, "error": err}), 500)
    if loading:
        return False, (jsonify({"ok": False, "loading": True}), 503)
    return False, (jsonify({"ok": False, "loading": False, "error": "unknown"}), 500)

@APP.get("/health")
def health():
    # Do NOT force-load unless eager-load enabled.
    eager = _as_bool(_env("XTTS_EAGER_LOAD", "1"), True)
    if eager:
        load_model_if_needed()
    with MODEL_LOCK:
        ready = MODEL is not None
        err = LOAD_ERROR
        loading = LOADING
    return jsonify({
        "ok": ready and not loading and not err,
        "ready": ready,
        "loading": loading,
        "error": err,
        "device": pick_device(),
    })

@APP.post("/speak")
def speak():
    ok, resp = ensure_loaded_or_503()
    if not ok:
        return resp

    data = request.get_json(force=True, silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"ok": False, "error": "Missing 'text'"}), 400

    # Optional: reference audio (emotion conditioning)
    refs_dir = Path(_env("XTTS_REFS_DIR", "")).expanduser().resolve()
    ref = (data.get("ref") or "").strip()
    speaker_wav = None
    if ref:
        # allow both "angry.wav" or "angry" (auto-add .wav)
        cand = ref
        if not cand.lower().endswith(".wav"):
            cand = cand + ".wav"
        p = (refs_dir / cand)
        if p.exists():
            speaker_wav = str(p)
        else:
            # ignore missing ref (do not error: keep normal speech)
            speaker_wav = None

    language = (data.get("language") or "en").strip() or "en"

    # Synthesis
    with MODEL_LOCK:
        m = MODEL

    device = pick_device()
    try:
        use_fp16 = _as_bool(_env("XTTS_FP16", "0"), False) and device.startswith("cuda")
        # Keep the model weights in fp32 for stability; use autocast for fp16 compute when enabled.
        ctx = (torch.autocast(device_type="cuda", dtype=torch.float16) if use_fp16 else nullcontext())
        with torch.inference_mode():
            with ctx:
                out = m.synthesize(
                    text,
                    config=m.config,
                    speaker_wav=speaker_wav,
                    language=language,
                )
        wav = out.get("wav")

        if wav is None:
            return jsonify({"ok": False, "error": "No wav produced"}), 500

        # Convert float32/float16 numpy -> int16 pcm wav bytes
        import numpy as np
        import io
        import wave as wave_mod

        wav_np = np.array(wav, dtype=np.float32)
        wav_np = np.clip(wav_np, -1.0, 1.0)
        pcm16 = (wav_np * 32767.0).astype(np.int16)

        buf = io.BytesIO()
        with wave_mod.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            # XTTS usually 24000; fall back to config if present
            sr = getattr(getattr(m, "config", None), "audio", None)
            sample_rate = 24000
            try:
                if sr and hasattr(sr, "sample_rate") and sr.sample_rate:
                    sample_rate = int(sr.sample_rate)
            except Exception:
                pass
            wf.setframerate(sample_rate)
            wf.writeframes(pcm16.tobytes())

        buf.seek(0)
        return Response(buf.read(), mimetype="audio/wav")

    except Exception as e:
        msg = str(e)
        # If CUDA hits a device-side assert, the process is usually poisoned until restart.
        if "device-side assert" in msg.lower():
            print("[XTTS] CUDA device-side assert triggered; restart the XTTS process.", flush=True)
        return jsonify({"ok": False, "error": msg}), 500

def _eager_load_thread():
    # background eager load to keep /health responsive
    load_model_if_needed()

def main():
    port = int(_env("XTTS_PORT", "5055"))
    eager = _as_bool(_env("XTTS_EAGER_LOAD", "1"), True)
    if eager:
        t = threading.Thread(target=_eager_load_thread, daemon=True)
        t.start()

    # Flask production-ish defaults
    APP.run(host="127.0.0.1", port=port, debug=False, threaded=True)

if __name__ == "__main__":
    main()
