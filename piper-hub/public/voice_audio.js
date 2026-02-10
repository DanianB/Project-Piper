// ----------------------
// Audio queue (prevents cutoffs)
// ----------------------
const audioQueue = [];
let audioPlaying = false;

// Optional: simple debounce to avoid stacking tons of clips if user spams.
const MAX_QUEUE = 6;

async function playNextInQueue() {
  if (audioPlaying) return;
  const item = audioQueue.shift();
  if (!item) return;

  audioPlaying = true;
  try {
    const { blob, meta } = item;

    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.src = url;

    // Attempt to allow overlapping browsers to play without user gesture issues
    audio.preload = "auto";

    // (debugEmotion removed)

    // Wait for play to start (some browsers reject without user gesture)
    await audio.play().catch((e) => {
      console.warn("[voice] audio.play failed:", e);
      // If playback fails, drop this clip and continue
    });

    // Wait until it finishes (or errors)
    await new Promise((resolve) => {
      const done = () => resolve();
      audio.addEventListener("ended", done, { once: true });
      audio.addEventListener("error", done, { once: true });
      audio.addEventListener("stalled", done, { once: true });
    });

    URL.revokeObjectURL(url);
  } finally {
    audioPlaying = false;
    // Continue queue
    if (audioQueue.length) playNextInQueue();
  }
}

function enqueueAudioBlob(blob, meta) {
  // Keep queue bounded
  while (audioQueue.length >= MAX_QUEUE) audioQueue.shift();
  audioQueue.push({ blob, meta });
  playNextInQueue();
}

// Speak helper: fetch audio and enqueue it (instead of letting a new one cut off old playback)
async function piperSpeak(text, emotion, intensity) {
  try {
    const payload = { text: String(text || ""), sessionId: window.sessionId };
    if (emotion) payload.emotion = emotion;
    if (typeof intensity === "number") payload.intensity = intensity;

    const r = await fetch("/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "(no body)");
      console.warn("/voice/speak failed:", r.status, body, payload);
      return;
    }

    // Expect server returns audio/wav bytes
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("audio")) {
      // Server may respond JSON when it plays audio server-side.
      if (ct.includes("application/json")) {
        const j = await r.json().catch(() => null);
        if (j && j.ok) return;
        console.warn("/voice/speak json response:", j);
        return;
      }
      const body = await r.text().catch(() => "(no body)");
      console.warn("/voice/speak unexpected content-type:", ct, body);
      return;
    }

    const blob = await r.blob();
    enqueueAudioBlob(blob, {
      emotion: payload.emotion,
      intensity: payload.intensity,
      chars: payload.text.length,
    });

    // (debugEmotion removed)
  } catch (e) {
    console.warn("/voice/speak error:", e);
  }
}

// expose
window.piperSpeak = piperSpeak;
