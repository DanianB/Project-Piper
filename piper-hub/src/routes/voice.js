// src/routes/voice.js
import { Router } from "express";
import multer from "multer";
import { transcribeAudioBuffer } from "../services/voice/stt.js";
import {
  speakQueued,
  getVoiceConfig,
  setVoiceConfig,
  listVoices,
  ensureChatterboxRunning,
  getChatterboxStatus,
} from "../services/voice/tts.js";

const upload = multer({ storage: multer.memoryStorage() });

export function voiceRoutes() {
  const r = Router();

  r.post("/voice/transcribe", upload.single("audio"), async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ ok: false, error: "No audio uploaded" });
      }
      const text = await transcribeAudioBuffer(req.file.buffer);
      res.json({ ok: true, text });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/voice/config", (_req, res) => res.json(getVoiceConfig()));

  r.post("/voice/config", (req, res) => {
    try {
      const next = setVoiceConfig(req.body || {});
      res.json({ ok: true, config: next });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/voice/voices", (_req, res) => res.json(listVoices()));

  r.post("/voice/speak", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.json({ ok: true });

    const emotion = req.body?.emotion; // optional
    const intensity = req.body?.intensity; // optional

    try {
      await speakQueued(text, { emotion, intensity });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/voice/chatterbox/start", async (_req, res) => {
    try {
      await ensureChatterboxRunning();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/voice/chatterbox/status", async (_req, res) => {
    try {
      const status = await getChatterboxStatus();
      res.json({ ok: true, status });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return r;
}
