import { Router } from "express";
import { startChatterboxProcess } from "../services/chatterbox_manager.js";
import multer from "multer";
import { transcribeAudioBuffer } from "../services/voice/stt.js";
import {
  speakQueued,
  getVoiceConfig,
  setVoiceConfig,
  listVoices,
  ensureChatterboxRunning,
  getChatterboxStatus,
  synthesizeWavBuffer,
} from "../services/voice/tts.js";
import { recordEvent } from "../services/mind.js";
import { streamChatterboxPcmToHttp } from "../services/voice/chatterbox_stream.js";

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

  // ---- Voice config ----
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

  // ---- Speak (returns audio for browser playback) ----
  r.post("/voice/speak", async (req, res) => {
    try {
      const {
        text = "",
        emotion = "neutral",
        intensity = 0.4,
        sessionId = null,
      } = req.body || {};

      // If using Chatterbox and autostart is enabled, ensure the process is running before speaking.
      const cfg = getVoiceConfig();
      const provider = cfg?.provider || "piper";
      const autostart = Boolean(cfg?.autoStartChatterbox);

      if (provider === "chatterbox") {
        if (autostart) {
          const r0 = await startChatterboxProcess();
          if (!r0?.ok) {
            return res
              .status(500)
              .json({
                ok: false,
                error: `Chatterbox failed to start: ${r0?.error || "unknown"}`,
              });
          }
        }
        // Still verify server endpoint is reachable (covers the case where port is blocked / dying).
        await ensureChatterboxRunning();
      }

      const wav = await synthesizeWavBuffer(String(text || ""), {
        emotion,
        intensity,
      });

      if (sessionId)
        recordEvent(sessionId, "tts_success", {
          emotion,
          intensity,
          chars: String(text || "").length,
        });

      // Return WAV bytes so the browser can play them.
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(Buffer.from(wav));
    } catch (e) {
      // Don’t hard-fail the UI—report error but keep HTTP 200.
      return res.status(200).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- True streaming (PCM16LE framed stream) ----
  r.post("/voice/stream", async (req, res) => {
    try {
      const { text = "", emotion = "neutral", intensity = 0.4 } = req.body || {};
      const cfg = getVoiceConfig();

      // Ensure chatterbox is running if selected.
      if ((cfg?.provider || "piper") === "chatterbox") {
        if (Boolean(cfg?.autoStartChatterbox)) {
          const r0 = await startChatterboxProcess();
          if (!r0?.ok) {
            return res.status(500).json({ ok: false, error: `Chatterbox failed to start: ${r0?.error || "unknown"}` });
          }
        }
        await ensureChatterboxRunning();
      }

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Audio-Format", "pcm_s16le");
      res.setHeader("X-Audio-Sample-Rate", String(Number(process.env.CHATTERBOX_STREAM_SR || "24000")));
      res.setHeader("X-Audio-Channels", "1");

      await streamChatterboxPcmToHttp({
        text: String(text || ""),
        emotion,
        intensity,
        res,
      });
    } catch (e) {
      try {
        res.status(500).end();
      } catch {}
    }
  });

  // ---- Chatterbox helpers ----
  r.post("/voice/chatterbox/start", async (_req, res) => {
    try {
      await startChatterboxProcess({ quiet: false });
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
