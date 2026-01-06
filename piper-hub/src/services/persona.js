// src/services/persona.js
//
// Light-touch "Jarvis" polishing for Piper text + TTS.
// Goal: keep personality consistent without adding latency or changing meaning.

export function enforceJarvis(text) {
  let s = String(text || "").trim();
  if (!s) return "Understood.";

  // Prevent "Sir, Sir," spam and other repeats
  s = s.replace(/\bSir,\s*Sir,\s*/gi, "Sir, ");
  s = s.replace(/(\bSir\b[,\s]*){2,}/gi, "Sir, ");

  // If the reply contains no "sir" at all, add it occasionally (deterministic rule):
  // - Only for short replies (keeps it from appearing every paragraph)
  // - Only once per reply (prefers front)
  const hasSir = /\bsir\b/i.test(s);
  if (!hasSir && s.length <= 220) {
    // If it's already a greeting, append "sir" naturally.
    if (/^(hi|hello|good (morning|afternoon|evening))\b/i.test(s)) {
      // "Hello, sir." style
      s = s.replace(
        /^(hi|hello|good (morning|afternoon|evening))\b/i,
        (m) => `${m}, sir`
      );
    } else {
      // Otherwise a single respectful prefix
      s = `Sir, ${s}`;
    }
  }

  // Collapse whitespace
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

/**
 * Voice-friendly output: slightly more natural, fewer symbols/markdown.
 */
export function makeSpoken(text) {
  let s = String(text || "").trim();
  if (!s) return "Understood.";

  // Strip basic markdown/code fencing and emojis that TTS can read awkwardly
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/[🧠✅⚠️⏹️▶️]/g, "");
  s = s.replace(/\s{2,}/g, " ").trim();

  return enforceJarvis(s);
}
