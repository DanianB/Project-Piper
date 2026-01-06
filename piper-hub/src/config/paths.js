import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------- Root ---------- */
export const ROOT = path.resolve(__dirname, "../..");

/* ---------- Core dirs ---------- */
export const DATA_DIR = path.join(ROOT, "data");
export const TMP_DIR = path.join(ROOT, "tmp");
export const PUBLIC_DIR = path.join(ROOT, "public");

/* Ensure dirs exist */
for (const d of [DATA_DIR, TMP_DIR]) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {}
}

/* ---------- Piper ---------- */
export const PIPER_EXE =
  process.env.PIPER_EXE || path.join(ROOT, "tools", "piper", "piper.exe");

export const PIPER_VOICE =
  process.env.PIPER_VOICE || process.env.PIPER_MODEL || null;

/* ---------- Chatterbox ---------- */
export const CHATTERBOX_SERVER_PY =
  process.env.CHATTERBOX_SERVER_PY ||
  path.join(ROOT, "tools", "chatterbox_server.py");

// Folder containing one or more .wav prompt files used by Chatterbox.
// Default is your provided path; override with CHATTERBOX_PROMPT_DIR if needed.
export const CHATTERBOX_PROMPT_DIR =
  process.env.CHATTERBOX_PROMPT_DIR || "D:\\AI\\piper-tts\\voices";

// Optional: point directly at a single .wav prompt file.
export const CHATTERBOX_PROMPT_WAV = process.env.CHATTERBOX_PROMPT_WAV || "";

/* ---------- Audio / STT ---------- */
export const FFMPEG_EXE =
  process.env.FFMPEG_EXE || path.join(ROOT, "tools", "ffmpeg", "ffmpeg.exe");

export const WHISPER_EXE =
  process.env.WHISPER_EXE || path.join(ROOT, "tools", "whisper", "main.exe"); // adjust if your binary name differs

// Prefer env override; if unset, leave as empty string so callers can throw a clear "not found" error.
export const WHISPER_MODEL = process.env.WHISPER_MODEL || "";

// Threads for whisper-cli. Keep as a number (default 4).
export const WHISPER_THREADS = Number.parseInt(process.env.WHISPER_THREADS || "4", 10);

/* ---------- Voice / runtime files ---------- */
export const VOICE_CONFIG_PATH = path.join(DATA_DIR, "voice_config.json");

export const OFF_FLAG_PATH = path.join(DATA_DIR, "OFF.flag");

export const ACTIONS_FILE = path.join(DATA_DIR, "actions.json");
export const APPS_FILE = path.join(DATA_DIR, "apps.json");

/* ---------- Temp audio ---------- */
export const TMP_PIPER_TEXT = path.join(TMP_DIR, "piper_text.txt");
export const TMP_PIPER_WAV = path.join(TMP_DIR, "piper_out.wav");
export const TMP_CHATTERBOX_WAV = path.join(TMP_DIR, "chatterbox_out.wav");

/* ---------- Backward-compat aliases ---------- */
export const PIPER_MODEL = PIPER_VOICE;
export const PIPER_VOICE_PATH = PIPER_VOICE;
