// src/services/voice/tts.js
import fs from "fs";
import path from "path";
import http from "http";
import { exec, spawn } from "child_process";
import * as PATHS from "../../config/paths.js";
import { normalizeEmotion, clamp01, makeSpoken } from "../persona.js";

/* ---------------- Robust paths ---------------- */
const ROOT = PATHS.ROOT || process.cwd();
const DATA_DIR = PATHS.DATA_DIR || path.join(ROOT, "data");
const TMP_DIR = PATHS.TMP_DIR || path.join(ROOT, "tmp");
for (const d of [DATA_DIR, TMP_DIR]) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {}
}

/* ---------------- Voice Config ---------------- */
const VOICE_CONFIG_PATH = path.join(DATA_DIR, "voice_config.json");

const DEFAULT_CFG = {
  provider: "piper",
  voice: "amy",
  autoStartChatterbox: false,
  chatterbox: {
    cfg_weight: 0.35,
    exaggeration: 0.5,
    temperature: 0.8,

    // Supported by your chatterbox_server.py request model
    repetition_penalty: 1.2,
    min_p: 0.05,
    top_p: 1.0,

    max_new_tokens_mode: "estimate",
    max_new_tokens_min: 90,
    max_new_tokens_max: 700,
  },
};

export function getVoiceConfig() {
  try {
    if (!fs.existsSync(VOICE_CONFIG_PATH)) {
      fs.writeFileSync(
        VOICE_CONFIG_PATH,
        JSON.stringify(DEFAULT_CFG, null, 2),
        "utf8"
      );
      return { ...DEFAULT_CFG };
    }
    const parsed = JSON.parse(fs.readFileSync(VOICE_CONFIG_PATH, "utf8"));
    return { ...DEFAULT_CFG, ...(parsed || {}) };
  } catch {
    return { ...DEFAULT_CFG };
  }
}

export function setVoiceConfig(patch = {}) {
  const prev = getVoiceConfig();
  const next = { ...prev, ...(patch || {}) };

  if (
    patch &&
    typeof patch === "object" &&
    patch.chatterbox &&
    typeof patch.chatterbox === "object"
  ) {
    next.chatterbox = {
      ...(prev.chatterbox || {}),
      ...(patch.chatterbox || {}),
    };
  } else {
    next.chatterbox = prev.chatterbox || DEFAULT_CFG.chatterbox;
  }

  next.provider = next.provider === "chatterbox" ? "chatterbox" : "piper";
  if (next.provider === "chatterbox") next.voice = next.voice || "default";
  else {
    next.voice = next.voice || "amy";
    if (!["amy", "jarvis"].includes(String(next.voice).toLowerCase()))
      next.voice = "amy";
  }

  fs.writeFileSync(VOICE_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/* ---------------- Piper (Default) ---------------- */
const PIPER_EXE = PATHS.PIPER_EXE || null;
const AMY_VOICE_PATH = PATHS.PIPER_VOICE || null;
const JARVIS_VOICE_PATH =
  process.env.PIPER_JARVIS_VOICE ||
  (AMY_VOICE_PATH
    ? path.join(path.dirname(AMY_VOICE_PATH), "jarvis-medium.onnx")
    : null);

const TMP_PIPER_TEXT =
  PATHS.TMP_PIPER_TEXT || path.join(TMP_DIR, "piper_text.txt");
const TMP_PIPER_WAV =
  PATHS.TMP_PIPER_WAV || path.join(TMP_DIR, "piper_out.wav");

function resolvePiperVoicePath(voiceId) {
  const v = String(voiceId || "").toLowerCase();
  if (v.includes("jarvis")) return JARVIS_VOICE_PATH;
  return AMY_VOICE_PATH;
}

function runPiperToWav(text, voiceId = "amy") {
  return new Promise((resolve, reject) => {
    const voicePath = resolvePiperVoicePath(voiceId);

    if (!PIPER_EXE || !fs.existsSync(PIPER_EXE))
      return reject(new Error(`piper.exe not found: ${PIPER_EXE}`));
    if (!voicePath || !fs.existsSync(voicePath)) {
      return reject(
        new Error(
          `piper voice not found.\n` +
            `Expected Amy at PIPER_VOICE in src/config/paths.js, and jarvis-medium.onnx in same folder (or set PIPER_JARVIS_VOICE).\n` +
            `Resolved voicePath: ${voicePath}`
        )
      );
    }

    fs.writeFileSync(TMP_PIPER_TEXT, String(text || ""), "utf8");

    const child = spawn(
      PIPER_EXE,
      ["--model", voicePath, "--output_file", TMP_PIPER_WAV],
      {
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      }
    );

    let errBuf = "";
    child.stderr.on("data", (d) => (errBuf += String(d)));

    try {
      child.stdin.write(fs.readFileSync(TMP_PIPER_TEXT, "utf8"));
      child.stdin.end();
    } catch (e) {
      try {
        child.kill();
      } catch {}
      return reject(e);
    }

    child.on("exit", (code) => {
      if (code !== 0)
        return reject(
          new Error(`piper.exe exited ${code}: ${errBuf.slice(-1200)}`)
        );
      resolve(TMP_PIPER_WAV);
    });
  });
}

function playWavBlocking(wavPath) {
  return new Promise((resolve, reject) => {
    const ps = `powershell.exe -NoProfile -Command "$p='${String(
      wavPath
    ).replace(
      /'/g,
      "''"
    )}'; $m = New-Object System.Media.SoundPlayer $p; $m.PlaySync();"`;
    exec(ps, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

/* ---------------- Chatterbox (Piper) ---------------- */
const CHATTERBOX_HOST = process.env.CHATTERBOX_HOST || "127.0.0.1";
const CHATTERBOX_PORT = Number(process.env.CHATTERBOX_PORT || "4123");
const CHATTERBOX_BASE_PATH = (process.env.CHATTERBOX_BASE_PATH || "").trim();
const CHATTERBOX_URL = `http://${CHATTERBOX_HOST}:${CHATTERBOX_PORT}${CHATTERBOX_BASE_PATH}`;

const TMP_CHATTERBOX_WAV = path.join(TMP_DIR, "chatterbox_out.wav");

const HEALTH_CACHE_MS = Number(
  process.env.CHATTERBOX_HEALTH_CACHE_MS || "2000"
);
let _healthCache = { at: 0, data: null };

function resolveChatterboxPromptPath() {
  const explicit = String(
    PATHS.CHATTERBOX_PROMPT_WAV || process.env.CHATTERBOX_PROMPT_WAV || ""
  ).trim();
  if (explicit) {
    try {
      if (fs.existsSync(explicit) && fs.statSync(explicit).isFile())
        return explicit;
    } catch {}
  }

  const dir = String(
    PATHS.CHATTERBOX_PROMPT_DIR || process.env.CHATTERBOX_PROMPT_DIR || ""
  ).trim();
  if (!dir) return null;

  try {
    if (!fs.existsSync(dir)) return null;
    const st = fs.statSync(dir);
    if (st.isFile()) return dir.toLowerCase().endsWith(".wav") ? dir : null;
    if (!st.isDirectory()) return null;

    const files = fs
      .readdirSync(dir)
      .filter((f) => String(f).toLowerCase().endsWith(".wav"))
      .sort();
    if (!files.length) return null;
    return path.join(dir, files[0]);
  } catch {
    return null;
  }
}

function chooseMaxNewTokensLegacy(text) {
  const n = String(text || "").trim().length;
  if (n <= 80) return 180;
  if (n <= 160) return 260;
  if (n <= 260) return 360;
  if (n <= 360) return 480;
  return 600;
}

function chooseMaxNewTokensEstimate(text, cfg) {
  const s = String(text || "").trim();
  const words = s ? s.split(/\s+/).filter(Boolean).length : 0;

  const wordsPerSec = Number(process.env.CHATTERBOX_WORDS_PER_SEC || "2.7");
  const seconds = wordsPerSec > 0 ? words / wordsPerSec : 0;

  const tokensPerSec = Number(
    process.env.CHATTERBOX_AUDIO_TOKENS_PER_SEC || "25"
  );
  let tokens = Math.ceil(seconds * tokensPerSec);

  const margin = Number(process.env.CHATTERBOX_TOKEN_MARGIN || "50");
  tokens += margin;

  const minCap =
    Number(
      process.env.CHATTERBOX_MAX_NEW_TOKENS_MIN || cfg?.max_new_tokens_min || 90
    ) || 90;
  const maxCap =
    Number(
      process.env.CHATTERBOX_MAX_NEW_TOKENS_MAX ||
        cfg?.max_new_tokens_max ||
        700
    ) || 700;

  if (tokens < minCap) tokens = minCap;
  if (tokens > maxCap) tokens = maxCap;
  return tokens;
}

function chooseMaxNewTokens(text) {
  const cfg = getVoiceConfig();
  const cb = cfg?.chatterbox || DEFAULT_CFG.chatterbox;
  const mode = String(cb?.max_new_tokens_mode || "estimate").toLowerCase();
  if (mode === "legacy") return chooseMaxNewTokensLegacy(text);
  return chooseMaxNewTokensEstimate(text, cb);
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode || 0,
            json: JSON.parse(buf || "{}"),
          });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
  });
}

function normalizeHealthJson(json) {
  const j = json || {};
  const ok =
    Boolean(j.ok) ||
    Boolean(j.healthy) ||
    String(j.status || "").toLowerCase() === "healthy" ||
    String(j.status || "").toLowerCase() === "ok";
  const modelLoaded =
    j.model_loaded === undefined ? undefined : Boolean(j.model_loaded);
  const device = j.device ? String(j.device) : undefined;
  return { ok, modelLoaded, device, raw: j };
}

export async function getChatterboxStatus() {
  const now = Date.now();
  if (_healthCache.data && now - _healthCache.at < HEALTH_CACHE_MS)
    return _healthCache.data;

  try {
    const r = await httpGetJson(`${CHATTERBOX_URL}/health`);
    const norm = normalizeHealthJson(r.json);
    const data = {
      reachable: r.status > 0 && r.status < 500,
      statusCode: r.status,
      ok: r.status === 200 && norm.ok,
      device: norm.device,
      modelLoaded: norm.modelLoaded,
      raw: norm.raw,
      url: CHATTERBOX_URL,
      at: now,
    };
    _healthCache = { at: now, data };
    return data;
  } catch (e) {
    const data = {
      reachable: false,
      statusCode: 0,
      ok: false,
      device: undefined,
      modelLoaded: undefined,
      raw: undefined,
      url: CHATTERBOX_URL,
      at: now,
      error: String(e?.message || e),
    };
    _healthCache = { at: now, data };
    return data;
  }
}

export async function ensureChatterboxRunning() {
  const s = await getChatterboxStatus();
  if (s.ok) return true;
  try {
    const r2 = await httpGetJson(`${CHATTERBOX_URL}/openapi.json`);
    if (r2.status === 200) return true;
  } catch {}
  throw new Error(`Chatterbox not reachable at ${CHATTERBOX_URL}.`);
}

function httpPostWav(url, jsonBody, outPath) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(jsonBody), "utf8");
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "audio/wav",
          "Content-Length": String(body.length),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if ((res.statusCode || 0) >= 400) {
            return reject(
              new Error(
                `Chatterbox HTTP ${res.statusCode}: ${buf
                  .toString("utf8")
                  .slice(0, 2000)}`
              )
            );
          }
          fs.writeFileSync(outPath, buf);
          resolve(outPath);
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Emotion -> generation parameter mapping.
 * This is what makes TTS *actually* sound different.
 */
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function emotionToChatterboxParams(base, emotion, intensity) {
  const e = normalizeEmotion(emotion);
  const k = clamp01(intensity);

  let exaggeration = Number(base.exaggeration ?? 0.5);
  let cfg_weight = Number(base.cfg_weight ?? 0.5);
  let temperature = Number(base.temperature ?? 0.8);

  let repetition_penalty = Number(base.repetition_penalty ?? 1.2);
  let min_p = Number(base.min_p ?? 0.05);
  let top_p = Number(base.top_p ?? 1.0);

  // Apply deltas
  switch (e) {
    case "excited":
      exaggeration += 0.3 * k;
      temperature += 0.2 * k;
      cfg_weight -= 0.1 * k;
      repetition_penalty -= 0.05 * k;
      break;

    case "amused":
      exaggeration += 0.15 * k;
      temperature += 0.1 * k;
      cfg_weight -= 0.05 * k;
      break;

    case "dry":
      exaggeration -= 0.1 * k;
      temperature -= 0.1 * k;
      cfg_weight += 0.1 * k;
      break;

    case "confident":
      cfg_weight += 0.2 * k;
      temperature -= 0.05 * k;
      break;

    case "serious":
      cfg_weight += 0.15 * k;
      temperature -= 0.15 * k;
      exaggeration -= 0.1 * k;
      break;

    case "concerned":
    case "sad":
      cfg_weight += 0.2 * k;
      temperature -= 0.2 * k;
      exaggeration -= 0.2 * k;
      break;

    case "angry":
      // firmer, more forceful delivery
      exaggeration += 0.35 * k;
      cfg_weight += 0.1 * k;
      temperature += 0.05 * k;
      // tighten sampling a little so it stays crisp
      top_p = Math.max(0.85, top_p - 0.1 * k);
      break;

    case "apologetic":
      cfg_weight += 0.1 * k;
      temperature -= 0.1 * k;
      exaggeration -= 0.1 * k;
      break;

    case "warm":
      exaggeration += 0.1 * k;
      temperature += 0.05 * k;
      break;

    default:
      break;
  }

  // Clamp to sane ranges
  exaggeration = clamp(exaggeration, 0.0, 1.2);
  cfg_weight = clamp(cfg_weight, 0.1, 1.2);
  temperature = clamp(temperature, 0.1, 1.3);

  repetition_penalty = clamp(repetition_penalty, 0.9, 1.4);
  min_p = clamp(min_p, 0.0, 0.3);
  top_p = clamp(top_p, 0.6, 1.0);

  return {
    exaggeration,
    cfg_weight,
    temperature,
    repetition_penalty,
    min_p,
    top_p,
  };
}

async function runChatterboxToWav(text, voiceId = "default", meta = {}) {
  await ensureChatterboxRunning();

  const cfg = getVoiceConfig();
  const cb = cfg?.chatterbox || DEFAULT_CFG.chatterbox;

  const emotion = meta?.emotion ?? "neutral";
  const intensity = meta?.intensity ?? 0.4;

  const promptPath = resolveChatterboxPromptPath();

  const tuned = emotionToChatterboxParams(cb, emotion, intensity);

  const payload = {
    input: String(text || ""),
    voice: String(voiceId || "default"),

    max_new_tokens: chooseMaxNewTokens(text),

    // Core controls your server supports:
    ...tuned,

    ...(promptPath ? { audio_prompt_path: promptPath } : {}),
  };

  const endpoint = `${CHATTERBOX_URL}/audio/speech`;
  return await httpPostWav(endpoint, payload, TMP_CHATTERBOX_WAV);
}

/* ---------------- Public API ---------------- */
export function listVoices() {
  return {
    ok: true,
    voices: [
      { id: "amy", label: "Amy", provider: "piper" },
      { id: "jarvis", label: "Jarvis", provider: "piper" },
      { id: "default", label: "Piper", provider: "chatterbox" },
    ],
  };
}

let ttsQueue = Promise.resolve();

/**
 * Speak with optional emotion/intensity.
 * meta = { emotion, intensity }
 */
export function speakQueued(text, meta = {}) {
  ttsQueue = ttsQueue.then(async () => {
    const cfg = getVoiceConfig();
    const provider = cfg.provider || "piper";

    const emotion = meta?.emotion ?? "neutral";
    const intensity = meta?.intensity ?? 0.4;

    // Text shaping for spoken output (cadence), but NOT changing meaning
    const spoken = makeSpoken(text, emotion, intensity);

    let wavPath;
    if (provider === "chatterbox") {
      wavPath = await runChatterboxToWav(spoken, cfg.voice || "default", {
        emotion,
        intensity,
      });
    } else {
      // Piper.exe has no native emotion controls; cadence shaping still helps a bit
      wavPath = await runPiperToWav(spoken, cfg.voice || "amy");
    }

    await playWavBlocking(wavPath);
  });

  return ttsQueue;
}
