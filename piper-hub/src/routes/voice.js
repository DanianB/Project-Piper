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

// Temp files for Piper fallback
const TMP_DIR = path.join(DATA_DIR, "tmp");
const TMP_PIPER_TEXT = path.join(TMP_DIR, "piper_input.txt");
const TMP_PIPER_WAV = path.join(TMP_DIR, "piper_output.wav");

// Qwen imitation reference clips live here
const QWEN_REF_DIR = path.join(DATA_DIR, "qwen_refs");

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
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

  writeJsonSafe(VOICE_CONFIG_PATH, merged);
  return merged;
}

function listVoices() {
  // Piper fallback voices we know Piper Hub expects.
  // Qwen entries here are *modes* (not speakers).
  return [
    { provider: "qwen3", voice: "default_female" },
    { provider: "qwen3", voice: "custom" },
    { provider: "qwen3", voice: "imitation" },

    { provider: "piper", voice: "alba" },
    { provider: "piper", voice: "amy" },
    { provider: "piper", voice: "jarvis" },
  ];
}

function safeParseJsonBody(req) {
  // body may be UTF-16LE if coming from curl.exe on Windows
  const buf = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(req.body || "");
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

function emotionToInstruct(emotion, intensity = 0.4) {
  const e = String(emotion || "neutral")
    .trim()
    .toLowerCase();
  const i = Math.max(0, Math.min(1, Number(intensity || 0.4)));
  const strength =
    i >= 0.75
      ? "very"
      : i >= 0.5
        ? "clearly"
        : i >= 0.25
          ? "slightly"
          : "subtly";
  if (!e || e === "neutral") return "Speak naturally and clearly.";
  return `Speak in a ${strength} ${e} tone.`;
}

function getQwenBaseUrl(cfg) {
  return (
    process.env.QWEN3_TTS_URL ||
    cfg?.qwen3?.baseUrl ||
    "http://127.0.0.1:5005"
  ).replace(/\/$/, "");
}

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
  const modeRaw = String(q.mode || "").trim();
  const voiceRaw = String(voice || "").trim();

  const mode =
    modeRaw ||
    (["default_female", "custom", "imitation"].includes(voiceRaw)
      ? voiceRaw
      : "");

  const override = String(q.emotionOverride || "").trim();
  const link = q.emotionLink !== false;
  const emotionForInstruct = override ? override : link ? emotion : null;

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
    voice: mode || voiceRaw || "ryan",
    language: "english",
    instruct: finalInstruct,
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
async function synthesizeWavBuffer({ text, emotion, intensity, sessionId }) {
  const cfg = getVoiceConfig();
  const provider = normalizeProvider(cfg?.provider);

  // Primary voice
  const voice = normalizeVoice(cfg?.voice);

  // Fallback voice
  const fbProvider = normalizeProvider(cfg?.fallbackProvider || "piper");
  const fbVoice = String(cfg?.fallbackVoice || "alba")
    .trim()
    .toLowerCase();

  // Attempt provider
  try {
    if (provider === "qwen3") {
      return await synthesizeQwenWav({
        cfg,
        text,
        voice,
        emotion,
        intensity,
        sessionId,
      });
    }
  } catch (e) {
    console.log("[voice] Qwen failed, falling back:", String(e?.message || e));
  }

  // Fallback provider (Piper)
  return await synthesizePiperWav({
    text,
    voice: fbVoice,
  });
}

async function synthesizePiperWav({ text, voice = "alba" }) {
  ensureDir(TMP_DIR);

  fs.writeFileSync(TMP_PIPER_TEXT, String(text || ""), "utf8");

  // Find voice model path
  const onnxPath = path.join(VOICES_DIR, `en_US-${voice}-medium.onnx`);
  const jsonPath = onnxPath.replace(/\.onnx$/i, ".onnx.json");

  // Some voices are en_GB (e.g. alba)
  const fallbackOnnx = path.join(VOICES_DIR, `en_GB-${voice}-medium.onnx`);
  const fallbackJson = fallbackOnnx.replace(/\.onnx$/i, ".onnx.json");

  const modelOnnx = fs.existsSync(onnxPath) ? onnxPath : fallbackOnnx;
  const modelJson = fs.existsSync(jsonPath) ? jsonPath : fallbackJson;

  if (!fs.existsSync(modelOnnx)) {
    throw new Error(
      `Piper voice model not found for "${voice}" in ${VOICES_DIR}`,
    );
  }

  const args = [
    "--model",
    modelOnnx,
    "--config",
    modelJson,
    "--output_file",
    TMP_PIPER_WAV,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(PIPER_EXE, args, { windowsHide: true });
    child.on("error", reject);

    const input = fs.createReadStream(TMP_PIPER_TEXT, { encoding: "utf8" });
    input.pipe(child.stdin);

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(`piper.exe exited ${code}: ${stderr}`));
      resolve();
    });
  });

  return fs.readFileSync(TMP_PIPER_WAV);
}

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

      const resp = await Promise.race([
        fetch(url),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Qwen capabilities timeout")),
            1500,
          ),
        ),
      ]);

      const j = await resp.json().catch(() => null);

      if (!resp.ok) {
        return res.status(502).json({
          ok: false,
          error: (j && (j.error || j.message)) || `HTTP ${resp.status}`,
        });
      }

      return res.json(j || { ok: true, imitation_supported: false });
    } catch (e) {
      return res
        .status(502)
        .json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- Qwen imitation reference upload ----
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

        const ts = Date.now();
        const safeName = `qwen_ref_${ts}.wav`;
        const outPath = path.join(QWEN_REF_DIR, safeName);

        fs.writeFileSync(outPath, req.file.buffer);

        const next = setVoiceConfig({
          qwen3: {
            imitation: {
              enabled: true,
              refPath: outPath,
              voiceId: `qwen_ref_${ts}`,
            },
          },
        });

        return res.json({ ok: true, path: outPath, config: next });
      } catch (e) {
        return res
          .status(500)
          .json({ ok: false, error: String(e?.message || e) });
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

        const pcm = await wavToPcm16le(wav);

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Transfer-Encoding", "chunked");

        // Framed stream: [len32le][pcm...]
        const len = Buffer.alloc(4);
        len.writeUInt32LE(pcm.length, 0);
        res.write(len);
        res.write(pcm);
        res.end();
      } catch (e) {
        console.log("[voice] /voice/stream error", String(e?.stack || e));
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    },
  );

  return r;
}
