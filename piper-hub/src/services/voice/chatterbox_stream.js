// src/services/voice/chatterbox_stream.js
// Bridges chatterbox-streaming (Python) to an HTTP response as framed PCM.
// Frame format: [u32le byteLength][pcmBytes] ... [0]

import { spawn } from "child_process";
import path from "path";
import * as PATHS from "../../config/paths.js";

const ROOT = PATHS.ROOT || process.cwd();

function getCondaEnv() {
  return process.env.CHATTERBOX_CONDA_ENV || "chatterbox";
}

function getPythonScriptPath() {
  return path.join(ROOT, "tools", "chatterbox_stream_cli.py");
}

export async function streamChatterboxPcmToHttp({ text, emotion, intensity, res }) {
  return new Promise((resolve, reject) => {
    const envName = getCondaEnv();
    const script = getPythonScriptPath();

    const args = [
      "run",
      "-n",
      envName,
      "python",
      script,
      "--text",
      String(text || ""),
      "--emotion",
      String(emotion || "neutral"),
      "--intensity",
      String(typeof intensity === "number" ? intensity : 0.4),
      "--sample-rate",
      String(Number(process.env.CHATTERBOX_STREAM_SR || "24000")),
      "--chunk-ms",
      String(Number(process.env.CHATTERBOX_STREAM_CHUNK_MS || "30")),
    ];

    const proc = spawn("conda", args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += String(d || "")));

    // Pipe binary framed stream directly
    proc.stdout.on("data", (chunk) => {
      try {
        res.write(chunk);
      } catch {
        try {
          proc.kill();
        } catch {}
      }
    });

    const cleanup = () => {
      try {
        res.end();
      } catch {}
    };

    res.on("close", () => {
      try {
        proc.kill();
      } catch {}
    });

    proc.on("error", (e) => {
      cleanup();
      reject(e);
    });

    proc.on("exit", (code) => {
      cleanup();
      if (code === 0) return resolve();
      const msg = stderr.trim() || `chatterbox_stream_cli exited ${code}`;
      reject(new Error(msg));
    });
  });
}
