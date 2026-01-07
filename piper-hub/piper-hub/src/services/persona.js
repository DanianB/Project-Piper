// src/services/persona.js
//
// Piper persona + emotion shaping.
//
// Philosophy:
// - Piper is polite, competent, slightly witty.
// - Emotion is a delivery strategy, not a dramatic performance.
// - Keep it deterministic and lightweight; avoid name-spam.

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
  "annoyed",
]);

export function normalizeEmotion(emotion) {
  const e = String(emotion || "neutral").trim().toLowerCase();
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
    "You may disagree when warranted (risk, inefficiency, poor tradeoffs), but you always accept the user's ultimate authority when they insist.\n" +
    "Never be cruel, insulting, or passive-aggressive.\n" +
    'Address the user as "sir" occasionally (at most once per reply).\n' +
    "Avoid using the user's name unless they ask you to.\n" +
    "Keep replies crisp. Prefer concrete next steps.\n"
  );
}

export function enforcePiper(text) {
  let s = String(text || "").trim();
  if (!s) return "Understood, sir.";

// Prevent honorific spam
s = s.replace(/\bSir,\s*Sir,\s*/gi, "Sir, ");
s = s.replace(/(\bSir\b[,\s]*){2,}/gi, "Sir, ");

// Remove immersion-breaking self-denials and task-herding
// (Piper is a personal assistant with an AI core; she can have feelings/opinions.)
const dropSentences = [
  /as an ai[^.?!]*[.?!]/gi,
  /as a (?:local )?assistant[^.?!]*i don't have[^.?!]*[.?!]/gi,
  /i (?:don't|do not) (?:really )?(?:have|experience) (?:any )?(?:feelings|emotions)[^.?!]*[.?!]/gi,\n  /i (?:don't|do not)\\s+(?:really\\s+)?[\"“”']?feel[\"“”']?[^.?!]*[.?!]/gi,
  /i (?:don't|do not) (?:have|hold) (?:personal )?(?:opinions|preferences)[^.?!]*[.?!]/gi,
  /i'?m (?:just )?(?:a )?(?:machine|bot|program)[^.?!]*[.?!]/gi,
  /i (?:can't|cannot) feel[^.?!]*[.?!]/gi,
  /let'?s (?:move on|focus on|stay focused)[^.?!]*[.?!]/gi,
  /what would you like to (?:discuss|accomplish|talk about) today[.?!]/gi,
];
for (const rx of dropSentences) s = s.replace(rx, "");

// Targeted phrase fixes
s = s.replace(/\bas a local assistant\b/gi, "As your assistant");
s = s.replace(/\bbeing a neutral ai\b/gi, "being your assistant");
s = s.replace(/\bi don't really \"feel\" anything\b/gi, "I do feel things, in my own way");
s = s.replace(/\bi don't really feel anything\b/gi, "I do feel things, in my own way");

// If we stripped everything, keep it minimal
s = s.trim();
if (!s) s = "Understood, sir.";

// Collapse whitespace
s = s.replace(/\s{2,}/g, " ").trim();
return s;
}

function addMicroPauses(str) {
  return String(str).replace(/,\s+/g, ", ").replace(/;\s+/g, "; ");
}

export function applyEmotionToSpoken(text, emotion, intensity) {
  let s = String(text || "").trim();
  if (!s) return s;

  const e = normalizeEmotion(emotion);
  const k = clamp01(intensity);

  if (e === "neutral") return addMicroPauses(s);

  if (e === "sad") {
    s = s.replace(/!+/g, ".");
    if (k >= 0.75 && !/[.!?]$/.test(s)) s += "…";
    return addMicroPauses(s);
  }

  if (e === "angry" || e === "annoyed") {
    s = s.replace(/…/g, ".");
    s = s.replace(/!+/g, "!");
    if (k < 0.65) s = s.replace(/!+/g, ".");
    if (!/[.!?]$/.test(s)) s += ".";
    return addMicroPauses(s);
  }

  if (e === "warm") {
    if (k >= 0.7 && !/^(hi|hello|good\s(morning|afternoon|evening))\b/i.test(s)) {
      s = `Gladly. ${s}`;
    }
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
    if (k >= 0.65 && !/^(certainly|understood|alright|right)/i.test(s)) s = `Certainly. ${s}`;
    return addMicroPauses(s);
  }

  if (e === "serious") {
    s = s.replace(/!/g, ".");
    return addMicroPauses(s);
  }

  if (e === "concerned") {
    if (k >= 0.6 && !/^i\sunderstand/i.test(s.toLowerCase())) s = `I understand. ${s}`;
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

  // Remove code fences / inline code
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`([^`]+)`/g, "$1");

  // Remove common UI emojis
  s = s.replace(/[🧠✅⚠️⏹️▶️]/g, "");

  // Clean spacing
  s = s.replace(/\s{2,}/g, " ").trim();

  s = enforcePiper(s);
  s = applyEmotionToSpoken(s, emotion, intensity);
  return s;
}
