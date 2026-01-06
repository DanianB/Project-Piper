import { Router } from "express";
import multer from "multer";
import { transcribeAudioBuffer } from "../services/voice/stt.js";
import {
  speakQueued,
  getVoiceConfig,
  setVoiceConfig,
  listVoices,
  ensureChatterboxRunning,
} from "../services/voice/tts.js";
import { makeSpoken } from "../services/persona.js";

const upload = multer({ storage: multer.memoryStorage() });

export function voiceRoutes() {
  const r = Router();

  // ---- STT ----
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

  // ---- GET voice config ----
  r.get("/voice/config", (_req, res) => {
    res.json(getVoiceConfig());
  });

  // ---- SET voice config ----
  r.post("/voice/config", (req, res) => {
    try {
      const next = setVoiceConfig(req.body || {});
      res.json({ ok: true, config: next });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- List voices (debug/helper) ----
  r.get("/voice/voices", (_req, res) => {
    res.json(listVoices());
  });

  // ---- Speak ----
  r.post("/voice/speak", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.json({ ok: true });

    try {
      await speakQueued(makeSpoken(text));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- Optional: prewarm chatterbox ----
  r.post("/voice/chatterbox/start", async (_req, res) => {
    try {
      await ensureChatterboxRunning();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return r;
}
