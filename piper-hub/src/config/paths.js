import path from "path";
import fs from "fs";

export const ROOT = process.cwd();

export const DATA_DIR = path.join(ROOT, "data");
export const TMP_DIR = path.join(ROOT, "tmp");
export const ACTIONS_DIR = path.join(ROOT, "actions");

export const ACTIONS_FILE = path.join(DATA_DIR, "actions.json");
export const APPS_FILE = path.join(DATA_DIR, "apps.json");
export const OFF_FLAG_PATH = path.join(DATA_DIR, "OFF.flag");

// ---- EXE PATHS (update if needed) ----
export const FFMPEG_EXE =
  "C:\\Users\\Danian\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe";

export const WHISPER_EXE = "D:\\AI\\whisper\\whisper-cli.exe";
export const WHISPER_MODEL = "D:\\AI\\whisper\\models\\ggml-base.en.bin";
export const WHISPER_THREADS = 6;

export const PIPER_EXE = "D:\\AI\\piper-tts\\piper.exe";
export const PIPER_VOICE = "D:\\AI\\piper-tts\\voices\\en_US-amy-medium.onnx";

export const TMP_PIPER_TEXT = path.join(TMP_DIR, "piper_text.txt");
export const TMP_PIPER_WAV = path.join(TMP_DIR, "piper_out.wav");

// ensure dirs exist
for (const d of [DATA_DIR, TMP_DIR, ACTIONS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
