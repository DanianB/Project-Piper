const PERSONA = {
  maxReplySentences: 3,
  maxSpokenChars: 360,
};

export function enforceJarvis(text) {
  let t = String(text || "").trim();
  if (!t) return "…";
  t = t.replace(/\b(as an ai|language model|system prompt)\b/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  const parts = t.split(/(?<=[.!?])\s+/);
  return parts.slice(0, PERSONA.maxReplySentences).join(" ") || t;
}

export function makeSpoken(text) {
  let t = enforceJarvis(text)
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  if (t.length > PERSONA.maxSpokenChars)
    t = t.slice(0, PERSONA.maxSpokenChars).trim() + "…";
  return t;
}
