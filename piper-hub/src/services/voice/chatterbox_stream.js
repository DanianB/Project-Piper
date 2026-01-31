// src/services/voice/chatterbox_stream.js
// Minimal compatibility module to prevent boot crashes when voice.js imports this file.
// Provides a best-effort "stream" by requesting a WAV from the Chatterbox HTTP server
// and framing raw PCM (s16le) to the HTTP response.

import fs from "fs";
import path from "path";
import http from "http";
import { execFile } from "child_process";
import { TMP_DIR, FFMPEG_EXE } from "../../config/paths.js";

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr?.toString?.() ?? String(stderr ?? "");
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function wavToPcmS16le(wavBuffer, { sampleRate = 24000, channels = 1 } = {}) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const wavPath = path.join(TMP_DIR, `chatterbox_${Date.now()}_${Math.random().toString(16).slice(2)}.wav`);
  const pcmPath = path.join(TMP_DIR, `chatterbox_${Date.now()}_${Math.random().toString(16).slice(2)}.pcm`);
  fs.writeFileSync(wavPath, wavBuffer);

  // Convert to raw PCM for framed streaming to the browser.
  // NOTE: The client is expected to know/assume s16le mono at sampleRate.
  const args = [
    "-y",
    "-i", wavPath,
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ac", String(channels),
    "-ar", String(sampleRate),
    pcmPath
  ];
  await execFileAsync(FFMPEG_EXE, args, { windowsHide: true });
  const pcm = fs.readFileSync(pcmPath);

  // Best-effort cleanup
  try { fs.unlinkSync(wavPath); } catch {}
  try { fs.unlinkSync(pcmPath); } catch {}
  return { pcm, sampleRate, channels };
}

function writeFramedPcm(res, pcmBuffer, frameBytes = 8192) {
  let offset = 0;
  while (offset < pcmBuffer.length) {
    const end = Math.min(offset + frameBytes, pcmBuffer.length);
    const chunk = pcmBuffer.subarray(offset, end);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(chunk.length, 0);
    res.write(len);
    res.write(chunk);
    offset = end;
  }
}

async function requestChatterboxWav({ host, port, payload, timeoutMs = 120000 }) {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  const options = {
    host,
    port,
    path: "/audio/speech",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": body.length,
    },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (resp) => {
      if (resp.statusCode !== 200) {
        let errBody = "";
        resp.setEncoding("utf8");
        resp.on("data", (d) => (errBody += d));
        resp.on("end", () => reject(new Error(`Chatterbox HTTP ${resp.statusCode}: ${errBody}`)));
        return;
      }
      const chunks = [];
      resp.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      resp.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => {
      try { req.destroy(new Error("Chatterbox request timed out")); } catch {}
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Best-effort "stream" helper.
 * If the caller truly needs token-level streaming, this module is not it.
 *
 * @param {object} params
 * @param {import('express').Response} res
 * @param {object} opts
 */
export async function streamChatterboxPcmToHttp(
  params,
  res,
  opts = {}
) {
  const host = opts.host || process.env.CHATTERBOX_HOST || "127.0.0.1";
  const port = Number(opts.port || process.env.CHATTERBOX_PORT || "4123");

  // Map common Piper fields to the chatterbox request schema
  const payload = {
    input: params?.text ?? params?.input ?? "",
    voice: params?.voice ?? "default",
    audio_prompt_path: params?.audioPromptPath ?? process.env.CHATTERBOX_PROMPT_WAV ?? null,
    exaggeration: typeof params?.exaggeration === "number" ? params.exaggeration : 0.5,
    cfg_weight: typeof params?.cfg_weight === "number" ? params.cfg_weight : (typeof params?.intensity === "number" ? params.intensity : 0.35),
  };

  if (!payload.input || !String(payload.input).trim()) {
    throw new Error("Missing input text");
  }

  // Request WAV from chatterbox, convert to PCM, then frame it.
  const wav = await requestChatterboxWav({ host, port, payload });
  const { pcm, sampleRate, channels } = await wavToPcmS16le(wav, {
    sampleRate: Number(opts.sampleRate || process.env.TTS_STREAM_SAMPLE_RATE || 24000),
    channels: Number(opts.channels || process.env.TTS_STREAM_CHANNELS || 1),
  });

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("X-Audio-Format", "s16le");
  res.setHeader("X-Audio-Sample-Rate", String(sampleRate));
  res.setHeader("X-Audio-Channels", String(channels));

  // Write framed PCM and end.
  writeFramedPcm(res, pcm, Number(opts.frameBytes || process.env.TTS_STREAM_FRAME_BYTES || 8192));
  res.end();
}

// Backwards-compat alias (in case voice.js imports a different name)
export const streamChatterboxToHttp = streamChatterboxPcmToHttp;
