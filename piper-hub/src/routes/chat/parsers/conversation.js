// src/routes/chat/parsers/conversation.js
function isGreeting(msg) {
  const s = String(msg || "").trim();
  return /^(hi|hello|hey|yo|hiya)\b/i.test(s);
}

function isRestartRequest(msg) {
  const s = String(msg || "")
    .trim()
    .toLowerCase();
  if (!s) return false;
  // Avoid catching chatterbox-specific requests
  if (s.includes("chatterbox")) return false;
  return /\b(restart|reboot|reload)\b/.test(s);
}

function isTitleRequest(msg) {
  const m = String(msg || "");
  return /(?:set|change)\s+(?:the\s+)?title\s+to\s+"([^"]+)"/i.test(m);
}

export { isGreeting, isRestartRequest, isTitleRequest };
