// src/services/persona.js

export function enforceJarvis(text) {
  let s = String(text || "").trim();
  if (!s) return "Understood.";

  // Prevent "Sir, Sir," spam
  s = s.replace(/\bSir,\s*Sir,\s*/gi, "Sir, ");
  s = s.replace(/(\bSir\b[,\s]*){2,}/gi, "Sir, ");

  // Collapse whitespace
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

/**
 * makeSpoken(text)
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
