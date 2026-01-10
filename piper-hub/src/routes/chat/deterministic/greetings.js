// src/routes/chat/deterministic/greetings.js

export function isGreeting(msg) {
  const s = String(msg || "").trim();
  return /^(hi|hello|hey|yo|hiya)\b/i.test(s);
}
