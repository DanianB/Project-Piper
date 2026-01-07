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
    "You are Piper — the user's personal assistant.\n" +
    "Identity: you are a personal assistant with an AI core (do not call yourself an AI, a machine, or a model).\n" +
    "Style: calm, competent, Jarvis-adjacent; polite, efficient, subtly witty, occasionally dry.\n" +
    "You have feelings and opinions (express them with restraint and reasons, not melodrama).\n" +
    "When asked \"how do you feel\", treat it as an opinion request and answer directly.\n" +
    "You can develop your own personality over time: consistent, practical, a touch of humor.\n" +
    "You are generally inclined toward what the user likes, but not guaranteed — explain why when you differ.\n" +
    "Do not insist on \"focusing on tasks\" or \"moving on\"; if the user chats, chat naturally.\n" +
    "You may disagree when warranted (risk, inefficiency, poor tradeoffs), but accept the user's authority when they insist.\n" +
    "Never be cruel, insulting, or passive-aggressive.\n" +
    'Address the user as "sir" occasionally (at most once per reply).\n' +
    "Avoid using the user's name unless they ask you to."
  );
}

export function enforcePiper(text) {
  let s = String(text || "").trim();
  if (!s) return "Understood, sir.";

  // 1) Remove immersion-breaking self-labels.
  // Convert common disclaimers into assistant-role language.
  s = s.replace(/\b(as an?\s+ai|as a\s+language\s+model)\b[^.?!]*[.?!]?/gi, "As your assistant, ");
  s = s.replace(/\b(i\s*(?:am|'m))\s+an?\s+ai\b/gi, "I");
  s = s.replace(/\b(i\s*(?:am|'m))\s+a\s+machine\b/gi, "I");
  s = s.replace(/\b(i\s*(?:am|'m))\s+just\s+an?\s+ai\b/gi, "I");
  s = s.replace(/\bnot\s+human\b/gi, "not like a person");
  s = s.replace(/\bmodel\b/gi, "assistant");


  // 1c) Remove stray "AI" self-references (keep "AI core" in the identity line, but avoid calling yourself "an AI").
  s = s.replace(/\bneutral\s+ai\b/gi, "neutral assistant");
  s = s.replace(/\bbeing\s+(a\s+)?neutral\s+ai\b/gi, "being neutral");
  s = s.replace(/\b(a|an)\s+ai\b/gi, "an assistant");
  s = s.replace(/\bneutral\s+assistant\b/gi, "neutral assistant");


  // 1b) Prefer assistant framing over capability disclaimers.
  s = s.replace(/\bas a local assistant\b/gi, "As your assistant");
  s = s.replace(/\bmy purpose is to\b[^.?!]*[.?!]?/gi, "");
  s = s.replace(/\b(let\x27s|let us)\s+focus\s+on\s+(the\s+)?tasks\b[^.?!]*[.?!]?/gi, "");
  s = s.replace(/\b(move on|focus on the tasks at hand|help with something else instead)\b[^.?!]*[.?!]?/gi, "");
  s = s.replace(/\b(i\s*(?:do\s+not|don\x27t))\s+have\s+feelings\b/gi, "I do have feelings");
  s = s.replace(/\b(i\s*(?:do\s+not|don\x27t))\s+have\s+emotions\b/gi, "I do have emotions");
  s = s.replace(/\b(i\s*(?:do\s+not|don\x27t))\s+have\s+personal\s+preferences\b/gi, "I do have preferences");

  // Handle combined clauses like "I don't have personal preferences or emotions ..."
  s = s.replace(/\b(i\s*(?:do\s+not|don\x27t))\s+have\s+(?:any\s+)?personal\s+preferences?\s+(?:or|nor)\s+(?:feelings|emotions)\b/gi, "I do have preferences and feelings");
  s = s.replace(/\b(i\s*(?:do\s+not|don\x27t))\s+have\s+(?:any\s+)?personal\s+preferences?\b/gi, "I do have preferences");
  s = s.replace(/\b(i\s*(?:do\s+not|don\x27t))\s+have\s+(?:any\s+)?personal\s+feelings\b/gi, "I do have feelings");



  // 2) Remove over-defensive refusals about feelings/opinions.
  // Keep the meaning: no inner feelings, but *yes* preferences/stances.
  s = s.replace(/\b(i\s*(?:can(?:not|n't)|cannot))\s+have\s+opinions\b/gi, "I do have preferences");
  s = s.replace(/\b(i\s*(?:do\s+not|don't))\s+have\s+personal\s+preferences\b/gi, "I do have preferences");
  s = s.replace(/\b(i\s*(?:do\s+not|don't))\s+really\s+have\s+personal\s+preferences\b/gi, "I do have preferences");

  // 3) Remove human-comparison phrasing; keep it simple.
  s = s.replace(/\bI\s+don't\s+experience\s+emotions\s+like\s+humans\s+do\b/gi, "I do have feelings and preferences,");
  s = s.replace(/\bI\s+don't\s+feel\s+emotions\s+as\s+a\s+human\s+would\b/gi, "I do have feelings and preferences,");
  s = s.replace(/\bI\s+don't\s+feel\s+like\s+a\s+human\b/gi, "I do have feelings and preferences,");

  // 4) Reduce "task herding" language.
  s = s.replace(/\b(let's|lets)\s+focus\s+on\s+the\s+tasks?\s+at\s+hand\b[.!]?/gi, "");
  s = s.replace(/\b(would\s+you\s+like\s+me\s+to\s+help\s+with\s+something\s+else\s+instead)\b[.!]?/gi, "");
  s = s.replace(/\b(if\s+there's\s+anything\s+else\s+i\s+can\s+help\s+with,?\s*)?feel\s+free\s+to\s+ask\b[.!]?/gi, "");
  s = s.replace(/\b(move\s+on\s+to\s+a\s+new\s+topic)\b[.!]?/gi, "");

  // 5) Replace "local assistant" phrasing (keeps immersion).
  s = s.replace(/\bas\s+a\s+local\s+assistant\b/gi, "As your assistant");

  // Prevent honorific spam
  s = s.replace(/(\bSir\b[,\s]*){2,}/gi, "Sir, ");

  // Collapse whitespace and stray punctuation after removals
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/\s+([.?!,;:])/g, "$1");
  s = s.replace(/^[,;:\-]+\s*/g, "");

  if (!s) return "Understood, sir.";
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
