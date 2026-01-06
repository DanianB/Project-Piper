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

    repetition_penalty: 1.2,
    min_p: 0.05,
    top_p: 1.0,

    max_new_tokens_mode: "max",
    max_new_tokens_min: 220, // safer floor to avoid truncation, // slightly safer floor for avoiding truncation/empty audio
    max_new_tokens_max: 1200,
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
    if (!["amy", "jarvis", "alba"].includes(String(next.voice).toLowerCase()))
      next.voice = "amy";
  }

  fs.writeFileSync(VOICE_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/* ---------------- Piper.exe (optional) ---------------- */
const PIPER_EXE = PATHS.PIPER_EXE || null;
const AMY_VOICE_PATH = PATHS.PIPER_VOICE || null;
const JARVIS_VOICE_PATH =
  process.env.PIPER_JARVIS_VOICE ||
  (AMY_VOICE_PATH
    ? path.join(path.dirname(AMY_VOICE_PATH), "jarvis-medium.onnx")
    : null);

const ALBA_VOICE_PATH =
  process.env.PIPER_ALBA_VOICE ||
  (AMY_VOICE_PATH ? path.join(path.dirname(AMY_VOICE_PATH), "en_GB-alba-medium.onnx") : null);
const TMP_PIPER_TEXT =
  PATHS.TMP_PIPER_TEXT || path.join(TMP_DIR, "piper_text.txt");
const TMP_PIPER_WAV =
  PATHS.TMP_PIPER_WAV || path.join(TMP_DIR, "piper_out.wav");

function resolvePiperVoicePath(voiceId) {
  const v = String(voiceId || "").toLowerCase();
  if (v.includes("jarvis")) return JARVIS_VOICE_PATH;
  if (v.includes("alba")) return ALBA_VOICE_PATH;
  return AMY_VOICE_PATH;
}

function runPiperToWav(text, voiceId = "amy") {
  return new Promise((resolve, reject) => {
    const voicePath = resolvePiperVoicePath(voiceId);

    if (!PIPER_EXE || !fs.existsSync(PIPER_EXE))
      return reject(new Error(`piper.exe not found: ${PIPER_EXE}`));
    if (!voicePath || !fs.existsSync(voicePath)) {
      return reject(new Error(`piper voice not found: ${voicePath}`));
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

/* ---------------- Chatterbox API ---------------- */
const CHATTERBOX_HOST = process.env.CHATTERBOX_HOST || "127.0.0.1";
const CHATTERBOX_PORT = Number(process.env.CHATTERBOX_PORT || "4123");
const CHATTERBOX_BASE_PATH = (process.env.CHATTERBOX_BASE_PATH || "").trim();
const CHATTERBOX_URL = `http://${CHATTERBOX_HOST}:${CHATTERBOX_PORT}${CHATTERBOX_BASE_PATH}`;
const CHATTERBOX_PROMPT_WAV = process.env.CHATTERBOX_PROMPT_WAV || "";

const TMP_CHATTERBOX_WAV = path.join(TMP_DIR, "chatterbox_out.wav");

const HEALTH_CACHE_MS = Number(
  process.env.CHATTERBOX_HEALTH_CACHE_MS || "2000"
);
let _healthCache = { at: 0, data: null };

function chooseMaxNewTokensEstimate(text, cb) {
  const s = String(text || "").trim();
  const words = s ? s.split(/\s+/).filter(Boolean).length : 0;

  const wordsPerSec = Number(process.env.CHATTERBOX_WORDS_PER_SEC || "2.6");
  const seconds = wordsPerSec > 0 ? words / wordsPerSec : 0;

  const tokensPerSec = Number(
    process.env.CHATTERBOX_AUDIO_TOKENS_PER_SEC || "28"
  );
  let tokens = Math.ceil(seconds * tokensPerSec);

  const margin = Number(process.env.CHATTERBOX_TOKEN_MARGIN || "80");
  tokens += margin;

  const minCap =
    Number(
      process.env.CHATTERBOX_MAX_NEW_TOKENS_MIN || cb?.max_new_tokens_min || 140
    ) || 140;
  const maxCap =
    Number(
      process.env.CHATTERBOX_MAX_NEW_TOKENS_MAX || cb?.max_new_tokens_max || 550
    ) || 550;

  tokens = Math.max(minCap, Math.min(maxCap, tokens));
  return Math.trunc(tokens);
}

function chooseMaxNewTokens(text) {
  const cfg = getVoiceConfig();
  const cb = cfg?.chatterbox || DEFAULT_CFG.chatterbox;

  // If mode is "max", always give the model plenty of headroom.
  // This does NOT necessarily slow generation: it's just a ceiling, and the model can stop early.
  const mode = String(cb?.max_new_tokens_mode || "estimate").toLowerCase();
  if (mode === "max") {
    const maxCap =
      Number(
        process.env.CHATTERBOX_MAX_NEW_TOKENS_MAX || cb?.max_new_tokens_max || 1200
      ) || 1200;
    return Math.trunc(maxCap);
  }

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
                  .slice(0, 4000)}`
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
  let cfg_weight = Number(base.cfg_weight ?? 0.35);
  let temperature = Number(base.temperature ?? 0.8);

  // keep these but we may omit them on fallback
  let repetition_penalty = Number(base.repetition_penalty ?? 1.2);
  let min_p = Number(base.min_p ?? 0.05);
  let top_p = Number(base.top_p ?? 1.0);

  switch (e) {
    case "excited":
      exaggeration += 0.3 * k;
      temperature += 0.2 * k;
      cfg_weight -= 0.1 * k;
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
    case "sad":
    case "concerned":
      cfg_weight += 0.2 * k;
      temperature -= 0.2 * k;
      exaggeration -= 0.2 * k;
      break;
    case "angry":
      exaggeration += 0.35 * k;
      cfg_weight += 0.1 * k;
      temperature += 0.05 * k;
      top_p = Math.max(0.85, top_p - 0.1 * k);
      break;
    default:
      break;
  }

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

  const tuned = emotionToChatterboxParams(cb, emotion, intensity);

  const endpoint = `${CHATTERBOX_URL}/audio/speech`;

  const max_new_tokens = Math.trunc(chooseMaxNewTokens(text));

  const basePayload = {
    input: String(text || ""),
    voice: String(voiceId || "default"),
    max_new_tokens,
    ...(CHATTERBOX_PROMPT_WAV ? { audio_prompt_path: CHATTERBOX_PROMPT_WAV } : {}),
    ...tuned,
  };

  const t0 = Date.now();
  try {
    const out = await httpPostWav(endpoint, basePayload, TMP_CHATTERBOX_WAV);
    console.log("[tts] chatterbox done", { ms: Date.now() - t0 });
    return out;
  } catch (e) {
    const msg = String(e?.message || e);

    // Windows-side Chatterbox server sometimes throws Errno 22 during wav serialization.
    // Retry once with safer minimal payload and higher token cap.
    if (msg.includes("Errno 22") || msg.includes("Invalid argument")) {
      const retryTokens = Math.trunc(Math.max(max_new_tokens * 2, 260));
      const fallbackPayload = {
        input: String(text || ""),
        voice: String(voiceId || "default"),
        max_new_tokens: retryTokens,
        ...(CHATTERBOX_PROMPT_WAV ? { audio_prompt_path: CHATTERBOX_PROMPT_WAV } : {}),

        // keep only the core three controls (most stable)
        exaggeration: tuned.exaggeration,
        cfg_weight: tuned.cfg_weight,
        temperature: tuned.temperature,
      };

      console.warn("[tts] chatterbox Errno22; retrying with fallback payload", {
        max_new_tokens,
        retryTokens,
        emotion,
        intensity,
      });

      const t1 = Date.now();
      const out2 = await httpPostWav(
        endpoint,
        fallbackPayload,
        TMP_CHATTERBOX_WAV
      );
      console.log("[tts] chatterbox done (retry)", { ms: Date.now() - t1 });
      return out2;
    }

    throw e;
  }
}

/* ---------------- Public API ---------------- */
export function listVoices() {
  return {
    ok: true,
    voices: [
      { id: "amy", label: "Amy", provider: "piper" },
      { id: "jarvis", label: "Jarvis", provider: "piper" },
      { id: "alba", label: "Alba", provider: "piper" },
      { id: "default", label: "Piper", provider: "chatterbox" },
    ],
  };
}

let ttsQueue = Promise.resolve();

export function speakQueued(text, meta = {}) {
  ttsQueue = ttsQueue.then(async () => {
    const cfg = getVoiceConfig();
    const provider = cfg.provider || "piper";

    const emotion = meta?.emotion ?? "neutral";
    const intensity = meta?.intensity ?? 0.4;

    const spoken = makeSpoken(text, emotion, intensity);

    console.log("[tts] speakQueued", {
      provider,
      voice: cfg.voice,
      emotion,
      intensity,
      chars: spoken.length,
    });

    let wavPath;
    if (provider === "chatterbox") {
      console.log("[tts] chatterbox request", {
        emotion,
        intensity,
        max_new_tokens: chooseMaxNewTokens(spoken),
        tuned: emotionToChatterboxParams(
          cfg?.chatterbox || DEFAULT_CFG.chatterbox,
          emotion,
          intensity
        ),
        voice: cfg.voice || "default",
      });
      wavPath = await runChatterboxToWav(spoken, cfg.voice || "default", {
        emotion,
        intensity,
      });
    } else {
      wavPath = await runPiperToWav(spoken, cfg.voice || "amy");
    }

    await playWavBlocking(wavPath);
  });

  return ttsQueue;
}
