import { Router } from "express";
import multer from "multer";
import { transcribeAudioBuffer } from "../services/voice/stt.js";
import { speakQueued } from "../services/voice/tts.js";
import { makeSpoken } from "../services/persona.js";

const upload = multer({ storage: multer.memoryStorage() });

export function voiceRoutes() {
  const r = Router();

  r.post("/voice/transcribe", upload.single("audio"), async (req, res) => {
    try {
      if (!req.file || !req.file.buffer)
        return res
          .status(400)
          .json({ ok: false, error: "Missing audio (field 'audio')" });
      const text = await transcribeAudioBuffer(
        req.file.buffer,
        req.file.originalname
      );
      res.json({ ok: true, text });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  r.post("/voice/speak", (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.json({ ok: true });
    speakQueued(makeSpoken(text));
    res.json({ ok: true });
  });

  return r;
}
