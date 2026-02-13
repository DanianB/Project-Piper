import { Router } from "express";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { transcribeAudioBuffer } from "../services/voice/stt.js";
import { wavToPcm16le } from "../services/voice/wav_pcm.js";
import { PIPER_EXE } from "../config/paths.js";

/**
 * Voice routes (Chatterbox removed for now).
 *
 * Providers supported here:
 *   - qwen3 (alias: qwen): calls local Qwen3 TTS microservice (http://127.0.0.1:5005 by default)
 *   - piper: runs local piper.exe as a fallback (default voice: alba)
 *
 * Endpoints:
 *   POST /voice/speak   -> returns audio/wav
 *   POST /voice/stream  -> returns framed PCM16LE stream (len32le frames)
 */

const upload = multer({ storage: multer.memoryStorage() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VOICES_DIR = "E:\\AI\\piper-tts\\voices";
const DATA_DIR = path.resolve(__dirname, "../../data");
const VOICE_CONFIG_PATH = path.join(DATA_DIR, "voice_config.json");
const TTS_CONFIG_PATH = path.join(DATA_DIR, "tts.json");

const QWEN_CUSTOM_DESC_PATH = path.join(DATA_DIR, "qwen_custom_voice.txt");

// Temp files for Piper fallback
const TMP_DIR = path.join(DATA_DIR, "tmp");
const TMP_PIPER_TEXT = path.join(TMP_DIR, "piper_input.txt");
const TMP_PIPER_WAV = path.join(TMP_DIR, "piper_output.wav");

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readTextSafe(p, fallback = "") {
  try {
    if (!fs.existsSync(p)) return fallback;
    const s = fs.readFileSync(p, "utf-8");
    return String(s || "").trim();
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function normalizeProvider(p) {
  const raw = String(p || "")
    .trim()
    .toLowerCase();
  if (raw === "qwen") return "qwen3";
  if (!raw) return "qwen3";
  return raw;
}

function normalizeVoice(v) {
  const raw = String(v || "")
    .trim()
    .toLowerCase();
  if (!raw) return "ryan";
  return raw;
}

function getVoiceConfig() {
  const vc = readJsonSafe(VOICE_CONFIG_PATH, null);
  if (vc && typeof vc === "object") return vc;

  const tts = readJsonSafe(TTS_CONFIG_PATH, null);
  if (tts && typeof tts === "object") return tts;

  // Safe default: Qwen3 primary + Piper fallback
  return {
    provider: "qwen3",
    voice: "ryan",
    fallbackProvider: "piper",
    fallbackVoice: "alba",
  };
}

function setVoiceConfig(next) {
  const cur = getVoiceConfig();
  const merged = { ...cur, ...(next && typeof next === "object" ? next : {}) };

  merged.provider = normalizeProvider(merged.provider);
  merged.voice = normalizeVoice(merged.voice);
  merged.fallbackProvider = normalizeProvider(
    merged.fallbackProvider || "piper"
  );
  merged.fallbackVoice = String(merged.fallbackVoice || "alba")
    .trim()
    .toLowerCase();

  writeJsonSafe(VOICE_CONFIG_PATH, merged);
  return merged;
}

function listVoices() {
  // Piper fallback voices we know Piper Hub expects.
  return [
    { provider: "qwen3", voice: "ryan" },
    { provider: "qwen3", voice: "vivian" },
    { provider: "qwen3", voice: "serena" },
    { provider: "piper", voice: "alba" },
    { provider: "piper", voice: "amy" },
    { provider: "piper", voice: "jarvis" },
  ];
}

function getQwenBaseUrl(cfg) {
  return (
    process.env.QWEN3_TTS_URL ||
    cfg?.qwen3?.baseUrl ||
    "http://127.0.0.1:5005"
  ).replace(/\/$/, "");
}


function getXttsBaseUrl(cfg) {
  return (
    process.env.XTTS_URL ||
    process.env.PIPER_XTTS_URL ||
    cfg?.xtts?.baseUrl ||
    cfg?.xtts?.base_url ||
    "http://127.0.0.1:5055"
  ).replace(/\/$/, "");
}

function pickXttsRef(cfg, emotion) {
  // Prefer explicit config ref; otherwise map emotion -> a ref name; otherwise fall back to env/default.
  const fromCfg = (cfg?.xtts?.defaultRef || cfg?.xtts?.default_ref || cfg?.speaker_wav || "").trim();
  if (fromCfg) return fromCfg;

  const e = String(emotion || cfg?.emotion || "neutral").trim().toLowerCase();

  // Map common UI emotions to your trained ref file names
  const map = {
    neutral: "serious_neutral",
    serious: "serious_neutral",
    serious_neutral: "serious_neutral",
    happy: "happy",
    excited: "excited",
    angry: "angry",
    sad: "sad",
    worried: "worried",
    anxious: "anxious",
    sarcastic: "sarcastic",
    affectionate: "affectionate",
    calm: "calm",
    confident: "confident",
  };

  if (map[e]) return map[e];

  const envDefault = (process.env.XTTS_DEFAULT_REF || "").trim();
  if (envDefault) return envDefault;

  // Last resort: use whatever emotion string we got (server will try to resolve it)
  return e;
}


function emotionToInstruct(emotion, intensity) {
  const e = String(emotion || "neutral")
    .trim()
    .toLowerCase();
  const x = Number.isFinite(Number(intensity)) ? Number(intensity) : 0.35;

  if (e === "neutral") return "Neutral, natural.";
  if (e === "happy") return `Upbeat and warm (intensity ${x}).`;
  if (e === "sad") return `Soft and subdued (intensity ${x}).`;
  if (e === "angry") return `Firm and controlled (intensity ${x}).`;
  if (e === "excited") return `Energetic and lively (intensity ${x}).`;
  return `Match the emotion "${e}" (intensity ${x}).`;
}

function safeParseJsonBody(req) {
  // express.json() yields a plain object. express.raw() yields Buffer/Uint8Array.
  if (
    req &&
    req.body &&
    typeof req.body === "object" &&
    !Buffer.isBuffer(req.body) &&
    !(req.body instanceof Uint8Array)
  ) {
    return req.body;
  }

  const raw = req?.body;
  if (!raw) return {};

  const tryDecode = (enc) => {
    const s = Buffer.from(raw)
      .toString(enc)
      .trim()
      .replace(/^\uFEFF/, "");
    return JSON.parse(s);
  };

  try {
    return tryDecode("utf8");
  } catch {
    // PowerShell curl.exe can sometimes send UTF-16LE.
    return tryDecode("utf16le");
  }
}

function writeLen32Frame(res, buf) {
  const len = buf ? buf.length : 0;
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(len, 0);
  res.write(hdr);
  if (len > 0) res.write(buf);
}

function chunkTextForStreaming(text, maxChars) {
  const SENT_SPLIT_RE = /(?<=[\.\!\?])\s+/;
  const s = String(text || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!s) return [];
  if (s.length <= maxChars) return [s];

  const sentences = s.split(SENT_SPLIT_RE);
  const parts = [];
  let cur = "";

  for (const sentRaw of sentences) {
    const sent = String(sentRaw || "").trim();
    if (!sent) continue;

    if (sent.length > maxChars) {
      for (let i = 0; i < sent.length; i += maxChars) {
        parts.push(sent.slice(i, i + maxChars).trim());
      }
      cur = "";
      continue;
    }

    if (!cur) cur = sent;
    else if (cur.length + 1 + sent.length <= maxChars) cur = `${cur} ${sent}`;
    else {
      parts.push(cur);
      cur = sent;
    }
  }

  if (cur) parts.push(cur);
  return parts.filter(Boolean);
}

// ---------- Piper fallback (local piper.exe) ----------

function resolvePiperVoicePath(name) {
  const v = String(name || "alba")
    .trim()
    .toLowerCase();

  const map = {
    alba: "en_GB-alba-medium.onnx",
    amy: "en_US-amy-medium.onnx",
    jarvis: "en_US-ryan-medium.onnx",
  };

  const file = map[v] || map.alba;

  const full = path.join(VOICES_DIR, file);

  if (!fs.existsSync(full)) {
    throw new Error(`Piper voice not found: ${full}`);
  }

  return full;
}


async function synthesizeXttsWav({ text, ref, language, baseUrl }) {
  if (!baseUrl) baseUrl = getXttsBaseUrl(null);
  const url = baseUrl.replace(/\/$/, "") + "/speak";

  const payload = {
    text,
    ref: ref || undefined,
    language: language || "en",
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`XTTS /speak failed: ${r.status} ${r.statusText} ${t}`);
  }

  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}


async function synthesizePiperWav({ text, voice }) {
  if (!PIPER_EXE || !fs.existsSync(PIPER_EXE)) {
    throw new Error(
      `Piper TTS fallback not available (PIPER_EXE missing): ${
        PIPER_EXE || "(null)"
      }`
    );
  }

  const modelPath = resolvePiperVoicePath(voice);
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error(`Piper voice model missing: ${modelPath || "(null)"}`);
  }

  fs.mkdirSync(path.dirname(TMP_PIPER_TEXT), { recursive: true });
  fs.mkdirSync(path.dirname(TMP_PIPER_WAV), { recursive: true });
  fs.writeFileSync(TMP_PIPER_TEXT, String(text || ""), "utf8");

  // piper.exe reads text from stdin; we feed the file contents
  const stdinText = fs.readFileSync(TMP_PIPER_TEXT);

  await new Promise((resolve, reject) => {
    const args = ["-m", modelPath, "-f", TMP_PIPER_WAV];
    const p = spawn(PIPER_EXE, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(`piper.exe exited ${code}: ${stderr || "unknown error"}`)
      );
    });

    p.stdin.write(stdinText);
    p.stdin.end();
  });

  const wav = fs.readFileSync(TMP_PIPER_WAV);
  return wav;
}

// ---------- Qwen primary ----------

async function synthesizeQwenWav({
  cfg,
  text,
  voice,
  emotion,
  intensity,
  instruct,
}) {
  const baseUrl = getQwenBaseUrl(cfg);
  const url = `${baseUrl}/speak`;

  const baseInstruct = String(instruct || emotionToInstruct(emotion, intensity));

  // Custom voice description is stored in a local file so you can edit it safely.
  // This keeps UI simple and avoids losing it during HTML changes.
  const customDesc = readTextSafe(QWEN_CUSTOM_DESC_PATH, "");

  // For Qwen "custom" mode, send custom_description so the server can apply voice design/caching.
  // For other voices, omit it.
  const payload = {
    text: String(text || ""),
    voice: String(voice || "ryan"),
    language: "english",
    instruct: baseInstruct,
  };

  if (String(voice || "").toLowerCase() === "custom" && customDesc) {
    payload.custom_description = customDesc;
  }

  const body = JSON.stringify(payload);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `Qwen3 TTS HTTP ${resp.status}: ${errText || resp.statusText}`
    );
  }

  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Main synthesis path:
 *  - try Qwen3
 *  - fallback to Piper (Alba) if Qwen fails
 */
async function synthesizeWavBuffer({
  text,
  emotion,
  intensity,
  sessionId,
} = {}) {
  const cfg = getVoiceConfig();

  const provider = normalizeProvider(cfg?.provider || "qwen3");
  const voice = normalizeVoice(cfg?.voice || "ryan");

  const fallbackProvider = normalizeProvider(cfg?.fallbackProvider || "piper");
  const fallbackVoice = String(cfg?.fallbackVoice || "alba")
    .trim()
    .toLowerCase();

  const finalText = String(text || "").trim();
  if (!finalText) throw new Error("Missing input text");

  // Only support qwen3 as primary for now (as requested).
  if (provider === "xtts") {
    const baseUrl = getXttsBaseUrl(cfg);
    const ref = pickXttsRef(cfg, emotion);
    return await synthesizeXttsWav({
      text: finalText,
      ref,
      language: cfg?.language || "en",
      baseUrl,
    });
  }

  if (provider !== "qwen3") {
    // If config is set to piper, just run piper.
    if (provider === "piper") {
      return await synthesizePiperWav({
        text: finalText,
        voice: cfg?.voice || fallbackVoice,
      });
    }
    // Otherwise force qwen3.
  }

  try {
    return await synthesizeQwenWav({
      cfg,
      text: finalText,
      voice,
      emotion,
      intensity,
      instruct: null,
    });
  } catch (e) {
    // Fallback: Piper (Alba)
    if (fallbackProvider === "piper") {
      return await synthesizePiperWav({
        text: finalText,
        voice: fallbackVoice || "alba",
      });
    }
    throw e;
  }
}

async function streamChunkedTtsAsFramedPcm({ text, emotion, intensity, res }) {
  const chunkChars = Number(process.env.TTS_STREAM_CHUNK_CHARS || "220");
  const chunks = chunkTextForStreaming(text, chunkChars);
  if (chunks.length === 0) throw new Error("No text chunks produced");

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Audio-Format", "pcm_s16le");
  res.setHeader(
    "X-Audio-Sample-Rate",
    String(Number(process.env.TTS_STREAM_SR || "24000"))
  );
  res.setHeader("X-Audio-Channels", "1");
  res.setHeader("X-Audio-Framing", "len32le");
  try {
    res.flushHeaders?.();
  } catch {}

  const frameBytes = 4096; // must be even (int16)
  for (const chunk of chunks) {
    const wav = await synthesizeWavBuffer({ text: chunk, emotion, intensity });
    const { pcmBytes } = wavToPcm16le(wav);
    for (let i = 0; i < pcmBytes.length; i += frameBytes) {
      writeLen32Frame(res, pcmBytes.slice(i, i + frameBytes));
    }
  }

  // End marker
  writeLen32Frame(res, Buffer.alloc(0));
  res.end();
}

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

  r.post("/voice/config", express.json({ limit: "128kb" }), (req, res) => {
    try {
      const next = setVoiceConfig(req.body || {});
      res.json({ ok: true, config: next });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/voice/voices", (_req, res) => res.json(listVoices()));

  // ---- Speak (returns WAV) ----
  r.post(
    "/voice/speak",
    // Parse body here; supports curl.exe UTF-16LE too
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      try {
        const payload = safeParseJsonBody(req);
        const {
          text = "",
          input = "",
          emotion = "neutral",
          intensity = 0.4,
          sessionId = null,
        } = payload || {};

        const finalText = String(text || input || "");
        if (!finalText.trim()) {
          return res
            .status(400)
            .json({ ok: false, error: "Missing input text" });
        }

        const wav = await synthesizeWavBuffer({
          text: finalText,
          emotion,
          intensity,
          sessionId,
        });

        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send(wav);
      } catch (e) {
        console.log("[voice] /voice/speak error", String(e?.stack || e));
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    }
  );

  // ---- Stream (framed PCM16LE) ----
  r.post(
    "/voice/stream",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      try {
        const body = safeParseJsonBody(req);
        const { text = "", emotion = "neutral", intensity = 0.4 } = body || {};
        const finalText = String(text || "");
        if (!finalText.trim()) {
          return res
            .status(400)
            .json({ ok: false, error: "Missing input text" });
        }

        await streamChunkedTtsAsFramedPcm({
          text: finalText,
          emotion,
          intensity,
          res,
        });
      } catch (e) {
        console.log("[voice] /voice/stream error", String(e?.stack || e));
        try {
          res.status(500).end();
        } catch {}
      }
    }
  );

  return r;
}
