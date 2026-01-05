import fs from "fs";
import path from "path";
import { exec } from "child_process";
import {
  TMP_DIR,
  FFMPEG_EXE,
  WHISPER_EXE,
  WHISPER_MODEL,
  WHISPER_THREADS,
} from "../../config/paths.js";

export async function transcribeAudioBuffer(
  buffer,
  originalName = "audio.webm"
) {
  if (!fs.existsSync(FFMPEG_EXE))
    throw new Error(`ffmpeg.exe not found: ${FFMPEG_EXE}`);
  if (!fs.existsSync(WHISPER_EXE))
    throw new Error(`whisper-cli.exe not found: ${WHISPER_EXE}`);
  if (!fs.existsSync(WHISPER_MODEL))
    throw new Error(`whisper model not found: ${WHISPER_MODEL}`);

  const ext = (originalName || "").split(".").pop() || "webm";
  const rawPath = path.join(TMP_DIR, `in_audio.${ext}`);
  const wav16k = path.join(TMP_DIR, "in_16k.wav");
  fs.writeFileSync(rawPath, buffer);

  const ffCmd = `"${FFMPEG_EXE}" -y -i "${rawPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wav16k}"`;

  await new Promise((resolve, reject) => {
    exec(ffCmd, { windowsHide: true }, (err) =>
      err ? reject(err) : resolve()
    );
  });

  const whisperCmd = `"${WHISPER_EXE}" -m "${WHISPER_MODEL}" -f "${wav16k}" -t ${WHISPER_THREADS} --no-timestamps`;

  const wOut = await new Promise((resolve, reject) => {
    exec(whisperCmd, { windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout || ""))
    );
  });

  const text = wOut
    .replace(/\r/g, "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  return text;
}
