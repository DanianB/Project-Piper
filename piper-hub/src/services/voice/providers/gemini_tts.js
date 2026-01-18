import fs from "fs";
import path from "path";

// Gemini speech-generation returns raw PCM (L16) base64 in inlineData.
// We wrap it in a WAV header so Windows SoundPlayer can play it.

function pcm16ToWav(pcmBuf, { sampleRateHz = 24000, channels = 1 } = {}) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRateHz * blockAlign;

  const dataSize = pcmBuf.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuf]);
}

function extractBase64Pcm(json) {
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts;
  if (!Array.isArray(parts)) return null;

  // Find first part that contains inlineData with base64.
  for (const p of parts) {
    const data = p?.inlineData?.data;
    const mime = p?.inlineData?.mimeType;
    if (typeof data === "string" && data.length > 0) {
      return { base64: data, mimeType: mime || "" };
    }
  }
  return null;
}

export async function runGeminiToWav(
  text,
  { voiceName = "Despina", model = "gemini-2.5-flash-preview-tts", tmpDir, sampleRateHz = 24000, channels = 1 } = {}
) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  if (!tmpDir) throw new Error("tmpDir is required");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: String(text || "") }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: String(voiceName || "Despina") } },
      },
    },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = j?.error?.message || j?.message || `${r.status} ${r.statusText}`;
    throw new Error(`Gemini TTS failed: ${msg}`);
  }

  const extracted = extractBase64Pcm(j);
  if (!extracted?.base64) throw new Error("Gemini TTS returned no audio data");

  const pcm = Buffer.from(extracted.base64, "base64");
  const wav = pcm16ToWav(pcm, { sampleRateHz, channels });

  const safeVoice = String(voiceName || "voice").replace(/[^a-zA-Z0-9_-]+/g, "_");
  const outPath = path.join(tmpDir, `gemini_${safeVoice}_${Date.now()}.wav`);
  fs.writeFileSync(outPath, wav);

  // Basic sanity check: WAV header must start with RIFF.
  const head = wav.subarray(0, 4).toString("ascii");
  if (head !== "RIFF") throw new Error("Generated WAV did not start with RIFF header");

  return outPath;
}
