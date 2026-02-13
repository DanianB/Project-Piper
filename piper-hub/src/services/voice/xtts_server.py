"""Minimal XTTS v2 inference server for Piper.

Runs without extra web frameworks (uses Python stdlib http.server).

Usage:
  python xtts_server.py --model_dir E:\AI\piper_voice_curie --port 5007

Expected files in --model_dir:
  - best_model.pth (or best_model_*.pth)
  - config.json
  - vocab.json
  - refs\*.wav (optional, used by Piper to pass in a reference wav path)
"""

from __future__ import annotations

import argparse
import inspect
import io
import json
import os
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, Optional


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def find_first(pattern: str, root: Path) -> Optional[Path]:
    matches = sorted(root.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0] if matches else None


class XTTSEngine:
    def __init__(self, model_dir: Path, device: str = "auto"):
        self.model_dir = model_dir
        self.device = device

        cfg_path = model_dir / "config.json"
        if not cfg_path.exists():
            raise FileNotFoundError(f"Missing config.json in {model_dir}")

        ckpt = model_dir / "best_model.pth"
        if not ckpt.exists():
            ckpt = find_first("best_model_*.pth", model_dir)
        if ckpt is None or not ckpt.exists():
            # allow resuming from checkpoints
            ckpt = find_first("checkpoint_*.pth", model_dir)
        if ckpt is None or not ckpt.exists():
            raise FileNotFoundError(f"No best_model/checkpoint found in {model_dir}")

        vocab_path = model_dir / "vocab.json"
        if not vocab_path.exists():
            raise FileNotFoundError(f"Missing vocab.json in {model_dir}")

        # Imports are delayed so this script can show a clean error if deps are missing.
        import numpy as np  # noqa: F401
        import torch
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts

        self.torch = torch
        self.np = __import__("numpy")

        config = XttsConfig()
        config.load_json(str(cfg_path))
        model = Xtts.init_from_config(config)

        # Some TTS versions use load_checkpoint(..., checkpoint_path=..., vocab_path=...)
        # Others accept different kwarg names. We adapt using signature filtering.
        load_sig = inspect.signature(model.load_checkpoint)
        load_kwargs: Dict[str, Any] = {}
        for name, value in {
            "config": config,
            "checkpoint_path": str(ckpt),
            "checkpoint_file": str(ckpt),
            "vocab_path": str(vocab_path),
            "vocab_file": str(vocab_path),
            "use_deepspeed": False,
        }.items():
            if name in load_sig.parameters:
                load_kwargs[name] = value

        model.load_checkpoint(**load_kwargs)

        # Device placement
        if device == "cpu":
            self.device_name = "cpu"
        else:
            self.device_name = "cuda" if torch.cuda.is_available() else "cpu"
        if self.device_name == "cuda":
            model.cuda()
        model.eval()

        self.config = config
        self.model = model
        self.checkpoint_path = ckpt
        self.vocab_path = vocab_path

        eprint(
            f"[xtts_server] Loaded model from {self.checkpoint_path} on {self.device_name}"
        )

    def synth(self, text: str, language: str, speaker_wav: str, **gen: Any) -> bytes:
        if not text.strip():
            raise ValueError("text is empty")
        if not speaker_wav:
            raise ValueError("speaker_wav is required")

        # Inference signature varies across versions; filter supported kwargs.
        inf_sig = inspect.signature(self.model.inference)
        kwargs: Dict[str, Any] = {}
        base = {
            "text": text,
            "language": language,
            "speaker_wav": speaker_wav,
        }
        # Common generation controls (safe defaults)
        base.update(
            {
                "temperature": gen.get("temperature", None),
                "top_k": gen.get("top_k", None),
                "top_p": gen.get("top_p", None),
                "length_penalty": gen.get("length_penalty", None),
                "repetition_penalty": gen.get("repetition_penalty", None),
                "speed": gen.get("speed", None),
            }
        )
        # Drop Nones and unsupported
        for k, v in base.items():
            if v is None:
                continue
            if k in inf_sig.parameters:
                kwargs[k] = v

        out = self.model.inference(**kwargs)

        # Output formats vary. Try a few known shapes.
        wav = None
        sr = 24000
        if isinstance(out, dict):
            wav = out.get("wav") or out.get("audio")
            sr = int(out.get("sample_rate") or out.get("sr") or sr)
        elif isinstance(out, (list, tuple)):
            # Some versions return (wav, ...)
            wav = out[0]
        else:
            wav = out

        if wav is None:
            raise RuntimeError("XTTS inference returned no audio")

        wav_np = self.np.asarray(wav).astype(self.np.float32)
        wav_np = self.np.clip(wav_np, -1.0, 1.0)
        pcm = (wav_np * 32767.0).astype(self.np.int16)

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm.tobytes())
        return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    engine: XTTSEngine
    lock = threading.Lock()

    def _send(self, code: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") == "/health":
            payload = {
                "ok": True,
                "checkpoint": str(self.engine.checkpoint_path),
                "device": self.engine.device_name,
            }
            self._send(200, json.dumps(payload).encode("utf-8"))
            return
        self._send(404, json.dumps({"ok": False, "error": "not found"}).encode("utf-8"))

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/speak":
            self._send(404, json.dumps({"ok": False, "error": "not found"}).encode("utf-8"))
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
            text = str(data.get("text", ""))
            language = str(data.get("language", "en"))
            speaker_wav = str(data.get("speaker_wav", ""))

            # Make speaker wav path absolute if it was given relative to model dir.
            if speaker_wav and not os.path.isabs(speaker_wav):
                speaker_wav = str((self.engine.model_dir / speaker_wav).resolve())

            gen = data.get("gen", {}) or {}

            # XTTS uses GPU and is not thread-safe in some builds.
            with self.lock:
                wav_bytes = self.engine.synth(text, language, speaker_wav, **gen)

            self._send(200, wav_bytes, content_type="audio/wav")
        except Exception as ex:
            eprint("[xtts_server] error:", repr(ex))
            self._send(500, json.dumps({"ok": False, "error": str(ex)}).encode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model_dir", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5007)
    ap.add_argument("--device", default="auto", choices=["auto", "cpu"])
    args = ap.parse_args()

    model_dir = Path(args.model_dir).expanduser().resolve()
    engine = XTTSEngine(model_dir=model_dir, device=args.device)
    Handler.engine = engine

    httpd = HTTPServer((args.host, args.port), Handler)
    eprint(f"[xtts_server] Listening on http://{args.host}:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
