import { Router } from "express";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { transcribeAudioBuffer } from "../services/voice/stt.js";
import { wavToPcm16le } from "../services/voice/wav_pcm.js";
import { PIPER_EXE, FFMPEG_EXE } from "../config/paths.js";

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

const TMP_DIR = path.join(DATA_DIR, "tmp");
const TMP_PIPER_TEXT = path.join(TMP_DIR, "piper_input.txt");
const TMP_PIPER_WAV = path.join(TMP_DIR, "piper_output.wav");

// Qwen imitation reference clips live here
const QWEN_REF_DIR = path.join(DATA_DIR, "qwen_refs");
const QWEN_REF_CACHE_DIR = path.join(DATA_DIR, "qwen_ref_cache");

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

async function convertAudioToWav({ inputPath, outputPath, sampleRate = 24000 }) {
  ensureDir(path.dirname(outputPath));

  if (!FFMPEG_EXE || !fs.existsSync(FFMPEG_EXE)) {
    throw new Error(
      `FFMPEG_EXE not found. Set env FFMPEG_EXE or install tools/ffmpeg. Tried: ${FFMPEG_EXE}`
    );
  }

  const args = ["-y", "-i", inputPath, "-ac", "1", "-ar", String(sampleRate), "-vn", outputPath];

  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_EXE, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      resolve();
    });
  });

  return outputPath;
}

function pickFirstAudioFile(dir) {
  if (!dir || !fs.existsSync(dir)) return "";
  const files = fs
    .readdirSync(dir)
    .filter((f) => [".wav", ".mp3"].includes(path.extname(f).toLowerCase()))
    .sort();
  return files.length ? path.join(dir, files[0]) : "";
}

async function resolveImitationRefPath(cfg) {
  const q = cfg?.qwen3 || {};
  const im = q?.imitation || {};
  if (!im.enabled) return "";

  let refPath = String(im.refPath || "").trim();

  if (!refPath) {
    const refDir = String(im.refDir || "").trim();
    const refFile = String(im.refFile || "").trim();
    if (refDir) {
      refPath = refFile ? path.join(refDir, refFile) : pickFirstAudioFile(refDir);
    }
  }

  if (!refPath) return "";

  if (!fs.existsSync(refPath)) {
    throw new Error(`Imitation ref audio not found: ${refPath}`);
  }

  const ext = path.extname(refPath).toLowerCase();
  if (ext === ".wav") return refPath;

  if (ext === ".mp3") {
    ensureDir(QWEN_REF_CACHE_DIR);
    const base = path.basename(refPath, ext);
    const outWav = path.join(QWEN_REF_CACHE_DIR, `${base}.wav`);
    const srcStat = fs.statSync(refPath);
    const need = !fs.existsSync(outWav) || fs.statSync(outWav).mtimeMs < srcStat.mtimeMs;
    if (need) {
      await convertAudioToWav({ inputPath: refPath, outputPath: outWav, sampleRate: 24000 });
    }
    return outWav;
  }

  throw new Error(`Unsupported ref audio type: ${ext} (expected .wav or .mp3)`);
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (_) {}
}

function getVoiceConfig() {
  const DEFAULTS = {
    provider: "piper",
    voice: "alba",
    autoStartChatterbox: false,
    chatterbox: {},
    qwen3: {
      mode: "default_female",
      customDescription: "",
      imitation: { enabled: false, voiceId: "", refPath: "" },
      emotionOverride: "",
      emotionLink: true,
    },
    fallbackProvider: "piper",
    fallbackVoice: "alba",
  };

  const vc = readJsonSafe(VOICE_CONFIG_PATH, null);
  const base =
    vc && typeof vc === "object"
      ? vc
      : (() => {
          const tts = readJsonSafe(TTS_CONFIG_PATH, null);
          return tts && typeof tts === "object" ? tts : {};
        })();

  const merged = { ...DEFAULTS, ...(base || {}) };

  // deep-merge qwen3
  merged.qwen3 = { ...DEFAULTS.qwen3, ...(base?.qwen3 || {}) };
  merged.qwen3.imitation = {
    ...DEFAULTS.qwen3.imitation,
    ...(base?.qwen3?.imitation || {}),
  };

  return merged;
}

function setVoiceConfig(next) {
  const cur = getVoiceConfig();
  const patch = next && typeof next === "object" ? next : {};

  const merged = {
    ...cur,
    ...patch,

    qwen3: {
      ...(cur.qwen3 || {}),
      ...(patch.qwen3 || {}),
      imitation: {
        ...(cur.qwen3?.imitation || {}),
        ...(patch.qwen3?.imitation || {}),
      },
    },
  };

  merged.provider = normalizeProvider(merged.provider);
  merged.voice = normalizeVoice(merged.voice);

  merged.fallbackProvider = normalizeProvider(
    merged.fallbackProvider || "piper",
  );
  merged.fallbackVoice = String(merged.fallbackVoice || "alba")
    .trim()
    .toLowerCase();

// ensure imitation is enabled when switching to imitation mode
if (merged.provider === "qwen3") {
  merged.qwen3 = merged.qwen3 && typeof merged.qwen3 === "object" ? merged.qwen3 : {};
  merged.qwen3.imitation =
    merged.qwen3.imitation && typeof merged.qwen3.imitation === "object"
      ? merged.qwen3.imitation
      : {};
  const isImitation = merged.voice === "imitation" || merged.qwen3.mode === "imitation";
  if (isImitation) merged.qwen3.imitation.enabled = true; // ensure imitation is enabled
}

writeJsonSafe(VOICE_CONFIG_PATH, merged);
  return merged;
}

function listVoices() {
  return [
    // Qwen modes (requested)
    { provider: "qwen3", voice: "default_female" },
    { provider: "qwen3", voice: "custom" },
    { provider: "qwen3", voice: "imitation" },

    // Piper voices (from E:\AI\piper-tts\voices)
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
  // If upstream middleware already parsed JSON, just use it.
  if (req && req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  // body may be UTF-16LE if coming from curl.exe on Windows
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  const asUtf8 = buf.toString("utf8").trim();
  if (asUtf8.startsWith("{") || asUtf8.startsWith("[")) {
    try {
      return JSON.parse(asUtf8);
    } catch {}
  }
  const asUtf16 = buf.toString("utf16le").trim();
  try {
    return JSON.parse(asUtf16);
  } catch {}
  return {};
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

async function synthesizePiperWav({ text, voice }) {
  if (!PIPER_EXE || !fs.existsSync(PIPER_EXE)) {
    throw new Error(
      `Piper TTS fallback not available (PIPER_EXE missing): ${
        PIPER_EXE || "(null)"
      }`,
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
        new Error(`piper.exe exited ${code}: ${stderr || "unknown error"}`),
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

  const q = (cfg && typeof cfg === "object" ? cfg.qwen3 : null) || {};
  const mode =
    String(q.mode || "").trim() ||
    // Back-compat: if UI sets voice directly to a mode
    (["default_female", "custom", "imitation"].includes(
      String(voice || "").trim(),
    )
      ? String(voice).trim()
      : "");

  // Emotion selection
  const override = String(q.emotionOverride || "").trim();
  const link = q.emotionLink !== false;

  const emotionForInstruct = override ? override : link ? emotion : null;

  // Build instruct text
  const parts = [];
  if (instruct) parts.push(String(instruct));
  else if (emotionForInstruct)
    parts.push(emotionToInstruct(emotionForInstruct, intensity));
  else parts.push("Speak naturally and clearly.");

  const desc = String(q.customDescription || "").trim();
  if (desc) parts.push(`Voice style: ${desc}`);

  const finalInstruct = parts.join(" ");

  const imitationEnabled = !!q?.imitation?.enabled;
  const refPath = imitationEnabled
    ? String(q?.imitation?.refPath || "").trim()
    : "";
  const voiceId = imitationEnabled
    ? String(q?.imitation?.voiceId || "").trim()
    : "";

  const body = JSON.stringify({
    text: String(text || ""),
    // If mode is set, send it; otherwise keep legacy voice value as-is.
    voice: mode || String(voice || "ryan"),
    language: "english",
    instruct: finalInstruct,

    // Plumbed for server support (next phase)
    ref_audio: refPath || null,
    voice_id: voiceId || null,
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `Qwen3 TTS HTTP ${resp.status}: ${errText || resp.statusText}`,
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
    String(Number(process.env.TTS_STREAM_SR || "24000")),
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

  // ---- Qwen capabilities (proxy) ----
  r.get("/voice/qwen/capabilities", async (_req, res) => {
    try {
      const cfg = getVoiceConfig();
      const baseUrl = getQwenBaseUrl(cfg);
      const url = `${baseUrl}/capabilities`;

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);

      const resp = await fetch(url, { signal: ctrl.signal }).finally(() =>
        clearTimeout(t),
      );

      const j = await resp.json().catch(() => null);
      if (!resp.ok) {
        return res.status(502).json({
          ok: false,
          error: (j && (j.error || j.message)) || `HTTP ${resp.status}`,
        });
      }

      res.json(j || { ok: true, imitation_supported: false });
    } catch (e) {
      res.status(502).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- Qwen imitation reference upload (stores WAV and updates config refPath) ----
  r.post(
    "/voice/qwen/imitation/upload",
    upload.single("audio"),
    async (req, res) => {
      try {
        if (!req.file || !req.file.buffer) {
          return res
            .status(400)
            .json({ ok: false, error: "Missing audio file." });
        }

        ensureDir(QWEN_REF_DIR);

        const ext = ".wav";
        const ts = Date.now();
        const safeName = `qwen_ref_${ts}${ext}`;
        const outPath = path.join(QWEN_REF_DIR, safeName);

        fs.writeFileSync(outPath, req.file.buffer);

        // Update voice_config.json with the new refPath + a simple voiceId
        const cur = getVoiceConfig();
        const next = setVoiceConfig({
          qwen3: {
            imitation: {
              enabled: true,
              refPath: outPath,
              voiceId: `qwen_ref_${ts}`,
            },
          },
        });

        res.json({ ok: true, path: outPath, config: next });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    },
  );

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
    },
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
    },
  );

  return r;
}
