import fs from "fs";
import path from "path";
import http from "http";
import { exec, spawn } from "child_process";
import * as PATHS from "../../config/paths.js";

/* ---------------- Robust paths (avoid named-export landmines) ---------------- */
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
  provider: "piper", // "piper" (Default) or "chatterbox" (Piper)
  voice: "amy", // for piper: "amy" | "jarvis"; for chatterbox: "default"
  autoStartChatterbox: false,
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
  const next = { ...getVoiceConfig(), ...(patch || {}) };

  // Normalize
  next.provider = next.provider === "chatterbox" ? "chatterbox" : "piper";
  if (next.provider === "chatterbox") {
    next.voice = next.voice || "default";
  } else {
    next.voice = next.voice || "amy";
    if (!["amy", "jarvis"].includes(String(next.voice).toLowerCase())) {
      next.voice = "amy";
    }
  }

  fs.writeFileSync(VOICE_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/* ---------------- Piper (Default) ---------------- */
const PIPER_EXE = PATHS.PIPER_EXE || null;

// We treat PATHS.PIPER_VOICE as "Amy"
const AMY_VOICE_PATH = PATHS.PIPER_VOICE || null;

// Jarvis model is expected in the same folder as Amy by default:
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

    if (!PIPER_EXE || !fs.existsSync(PIPER_EXE)) {
      return reject(new Error(`piper.exe not found: ${PIPER_EXE}`));
    }
    if (!voicePath || !fs.existsSync(voicePath)) {
      return reject(
        new Error(
          `piper voice not found.\n` +
            `Expected Amy at PIPER_VOICE in src/config/paths.js, and Jarvis at jarvis-medium.onnx in same folder (or set PIPER_JARVIS_VOICE).\n` +
            `Resolved voicePath: ${voicePath}`
        )
      );
    }

    fs.writeFileSync(TMP_PIPER_TEXT, String(text || ""), "utf8");

    const child = spawn(
      PIPER_EXE,
      ["--model", voicePath, "--output_file", TMP_PIPER_WAV],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] }
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
      if (code !== 0) {
        return reject(
          new Error(`piper.exe exited ${code}: ${errBuf.slice(-1200)}`)
        );
      }
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
const CHATTERBOX_URL = `http://${CHATTERBOX_HOST}:${CHATTERBOX_PORT}`;

const TMP_CHATTERBOX_WAV = path.join(TMP_DIR, "chatterbox_out.wav");

/**
 * Resolve an example prompt WAV for Chatterbox.
 *
 * Priority:
 *  1) Explicit file (PATHS.CHATTERBOX_PROMPT_WAV / env CHATTERBOX_PROMPT_WAV)
 *  2) Directory scan (PATHS.CHATTERBOX_PROMPT_DIR / env CHATTERBOX_PROMPT_DIR)
 *
 * Returns a string path, or null if none found.
 */
function resolveChatterboxPromptPath() {
  const explicit =
    (
      PATHS.CHATTERBOX_PROMPT_WAV ||
      process.env.CHATTERBOX_PROMPT_WAV ||
      ""
    ).trim?.() ||
    String(
      PATHS.CHATTERBOX_PROMPT_WAV || process.env.CHATTERBOX_PROMPT_WAV || ""
    ).trim();

  if (explicit) {
    try {
      if (fs.existsSync(explicit) && fs.statSync(explicit).isFile())
        return explicit;
    } catch {}
  }

  const dir =
    (
      PATHS.CHATTERBOX_PROMPT_DIR ||
      process.env.CHATTERBOX_PROMPT_DIR ||
      ""
    ).trim?.() ||
    String(
      PATHS.CHATTERBOX_PROMPT_DIR || process.env.CHATTERBOX_PROMPT_DIR || ""
    ).trim();

  if (!dir) return null;

  try {
    if (!fs.existsSync(dir)) return null;
    const st = fs.statSync(dir);
    if (st.isFile()) {
      // If user points dir var at a file, accept it (if it's wav).
      return dir.toLowerCase().endsWith(".wav") ? dir : null;
    }
    if (!st.isDirectory()) return null;

    const files = fs
      .readdirSync(dir)
      .filter((f) => String(f).toLowerCase().endsWith(".wav"))
      .sort((a, b) => a.localeCompare(b));

    if (!files.length) return null;
    return path.join(dir, files[0]);
  } catch {
    return null;
  }
}

function chooseMaxNewTokens(text) {
  const n = String(text || "").trim().length;
  if (n <= 80) return 180;
  if (n <= 160) return 260;
  if (n <= 260) return 360;
  if (n <= 360) return 480;
  return 600;
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

export async function ensureChatterboxRunning() {
  try {
    const r = await httpGetJson(`${CHATTERBOX_URL}/health`);
    if (r.status === 200 && r.json?.ok) return true;
  } catch {}

  try {
    const r2 = await httpGetJson(`${CHATTERBOX_URL}/openapi.json`);
    if (r2.status === 200) return true;
  } catch {}

  throw new Error(
    `Chatterbox not reachable at ${CHATTERBOX_URL}. Start it first (or enable auto-start later).`
  );
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

async function runChatterboxToWav(text, voiceId = "default") {
  await ensureChatterboxRunning();
  const promptPath = resolveChatterboxPromptPath();

  const payload = {
    input: String(text || ""),
    voice: String(voiceId || "default"),
    max_new_tokens: chooseMaxNewTokens(text),
    ...(promptPath ? { audio_prompt_path: promptPath } : {}),
  };
  return await httpPostWav(
    `${CHATTERBOX_URL}/audio/speech`,
    payload,
    TMP_CHATTERBOX_WAV
  );
}

/* ---------------- Public API ---------------- */
export function listVoices() {
  const voices = [
    { id: "amy", label: "Amy", provider: "piper" },
    { id: "jarvis", label: "Jarvis", provider: "piper" },
    { id: "default", label: "Piper", provider: "chatterbox" },
  ];
  return { ok: true, voices };
}

let ttsQueue = Promise.resolve();

/**
 * Queues TTS playback in-order.
 * Returns a Promise that resolves when this utterance has finished playing.
 */
export function speakQueued(text) {
  ttsQueue = ttsQueue.then(async () => {
    const cfg = getVoiceConfig();
    const provider = cfg.provider || "piper";

    let wavPath;
    if (provider === "chatterbox") {
      wavPath = await runChatterboxToWav(text, cfg.voice || "default");
    } else {
      wavPath = await runPiperToWav(text, cfg.voice || "amy");
    }

    await playWavBlocking(wavPath);
  });

  return ttsQueue;
}
