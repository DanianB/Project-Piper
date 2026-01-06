// src/services/persona.js

const EMOTIONS = new Set([
  "neutral",
  "warm",
  "amused",
  "confident",
  "serious",
  "concerned",
  "excited",
  "apologetic",
  "dry",
  "sad",
  "angry",
]);

export function normalizeEmotion(emotion) {
  const e = String(emotion || "neutral")
    .trim()
    .toLowerCase();
  if (EMOTIONS.has(e)) return e;
  return "neutral";
}

export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.4;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function piperSystemPrompt() {
  return (
    "You are Piper — a calm, competent, Jarvis-adjacent local assistant.\n" +
    "Core traits: polite, efficient, subtly witty, occasionally dry.\n" +
    "Be helpful and grounded; do not ramble.\n" +
    "You may be sharp, but never cruel or snarky.\n" +
    'Address the user as "sir" occasionally (at most once per reply).\n' +
    "Avoid using the user's name unless they ask you to.\n" +
    "When appropriate, include one brief witty remark.\n" +
    "If uncertain, say so plainly and suggest the next check.\n"
  );
}

export function enforcePiper(text) {
  let s = String(text || "").trim();
  if (!s) return "Understood, sir.";

  s = s.replace(/\bSir,\s*Sir,\s*/gi, "Sir, ");
  s = s.replace(/(\bSir\b[,\s]*){2,}/gi, "Sir, ");
  s = s.replace(/\s{2,}/g, " ").trim();

  return s;
}

export function applyEmotionToSpoken(text, emotion, intensity) {
  let s = String(text || "").trim();
  if (!s) return s;

  const e = normalizeEmotion(emotion);
  const k = clamp01(intensity);

  const addMicroPauses = (str) =>
    str.replace(/,\s+/g, ", ").replace(/;\s+/g, "; ");

  if (e === "neutral") return addMicroPauses(s);

  if (e === "sad") {
    // softer cadence; avoid exclamation, allow ellipsis very lightly
    s = s.replace(/!+/g, ".");
    if (k >= 0.75 && !/[.!?]$/.test(s)) s += "…";
    return addMicroPauses(s);
  }

  if (e === "angry") {
    // firmer cadence; still not theatrical
    s = s.replace(/…/g, ".");
    if (k >= 0.7 && !/[.!?]$/.test(s)) s += ".";
    return addMicroPauses(s);
  }

  if (e === "warm") {
    if (k >= 0.7 && !/^(hi|hello|good\s(morning|afternoon|evening))/i.test(s))
      s = `Gladly. ${s}`;
    return addMicroPauses(s);
  }

  if (e === "amused" || e === "dry") {
    if (k >= 0.75) {
      if (!/^(well,|right,|alright,)/i.test(s)) s = `Right. ${s}`;
      if (!/[.!?]$/.test(s)) s += ".";
    }
    return addMicroPauses(s);
  }

  if (e === "confident") {
    if (k >= 0.65 && !/^(certainly|understood|alright|right)/i.test(s))
      s = `Certainly. ${s}`;
    return addMicroPauses(s);
  }

  if (e === "serious") {
    s = s.replace(/!/g, ".");
    return addMicroPauses(s);
  }

  if (e === "concerned") {
    if (k >= 0.6 && !/^i\sunderstand/i.test(s.toLowerCase()))
      s = `I understand. ${s}`;
    return addMicroPauses(s);
  }

  if (e === "excited") {
    if (k >= 0.7) {
      s = s.replace(/!+/g, "!");
      if (!/[!?]$/.test(s)) s += "!";
    } else {
      s = s.replace(/!+/g, ".");
    }
    return addMicroPauses(s);
  }

  if (e === "apologetic") {
    if (!/^sorry/i.test(s)) s = `Sorry — ${s}`;
    s = s.replace(/!+/g, ".");
    return addMicroPauses(s);
  }

  return addMicroPauses(s);
}

export function makeSpoken(text, emotion = "neutral", intensity = 0.4) {
  let s = String(text || "").trim();
  if (!s) return "Understood.";

  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/[🧠✅⚠️⏹️▶️]/g, "");
  s = s.replace(/\s{2,}/g, " ").trim();

  s = enforcePiper(s);
  s = applyEmotionToSpoken(s, emotion, intensity);

  return s;
}
