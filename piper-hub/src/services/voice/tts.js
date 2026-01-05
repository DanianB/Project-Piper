import fs from "fs";
import { exec, spawn } from "child_process";
import {
  PIPER_EXE,
  PIPER_VOICE,
  TMP_PIPER_TEXT,
  TMP_PIPER_WAV,
} from "../../config/paths.js";

let ttsQueue = Promise.resolve();

function runPiperToWav(text) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PIPER_EXE))
      return reject(new Error(`piper.exe not found: ${PIPER_EXE}`));
    if (!fs.existsSync(PIPER_VOICE))
      return reject(new Error(`piper voice not found: ${PIPER_VOICE}`));

    fs.writeFileSync(TMP_PIPER_TEXT, String(text || ""), "utf8");

    const child = spawn(
      PIPER_EXE,
      ["--model", PIPER_VOICE, "--output_file", TMP_PIPER_WAV],
      {
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      }
    );

    let errBuf = "";
    child.stderr.on("data", (d) => (errBuf += String(d)));

    try {
      const inText = fs.readFileSync(TMP_PIPER_TEXT, "utf8");
      child.stdin.write(inText);
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
    const ps = `powershell.exe -NoProfile -Command "$p='${wavPath.replace(
      /'/g,
      "''"
    )}'; $m = New-Object System.Media.SoundPlayer $p; $m.PlaySync();"`;
    exec(ps, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

export function speakQueued(text) {
  ttsQueue = ttsQueue
    .then(async () => {
      const wav = await runPiperToWav(text);
      await playWavBlocking(wav);
    })
    .catch(() => {});
}
