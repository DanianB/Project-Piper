import fs from "fs";
import path from "path";
import * as PATHS from "../../../config/paths.js";

const ROOT = PATHS.ROOT || process.cwd();
const TMP_DIR = PATHS.TMP_DIR || path.join(ROOT, "tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

export async function runGeminiToWav(text, voice, emotion, intensity) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  // Gemini native TTS expects a prebuilt voice name (e.g., Kore, Aoede, Zephyr).
  const voiceName = String(voice || "Kore");

  const style = emotionStyle(emotion, intensity);
  const body = {
    contents: [{ parts: [{ text: `${style}

${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini TTS failed: ${res.status} ${t}`);
  }

  const json = await res.json();
  const b64 =
    json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ||
    json?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data;
  if (!b64) throw new Error("No audio returned");

  // The API returns base64 audio bytes (WAV/PCM depending on model). Piper plays the bytes as-is.
  const buf = Buffer.from(b64, "base64");
  const out = path.join(TMP_DIR, `gemini_${voiceName}_${Date.now()}.wav`);
  fs.writeFileSync(out, buf);
  return out;
}

function emotionStyle(emotion, intensity) {
  const i = Math.max(0, Math.min(1, intensity ?? 0.4));
  switch (String(emotion)) {
    case "angry":
      return `Speak with an intense, firm, angry tone (intensity ${i}).`;
    case "sad":
      return `Speak softly, slowly, and somberly (intensity ${i}).`;
    case "warm":
    case "happy":
      return `Speak warmly and cheerfully (intensity ${i}).`;
    case "excited":
      return `Speak energetically and enthusiastically (intensity ${i}).`;
    default:
      return `Speak naturally and clearly.`;
  }
}
