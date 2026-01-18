// src/routes/chat/parsers/webIntent.js
// Lightweight intent + query extraction for web search requests.

export function isWebSearchIntent(msg = "") {
  const s = String(msg || "").trim().toLowerCase();
  return (
    s.startsWith("search the web") ||
    s.startsWith("web search") ||
    s.startsWith("look up") ||
    s.startsWith("google") ||
    s.startsWith("find online") ||
    s.includes("search the web for") ||
    s.includes("look this up") ||
    s.includes("browse the web")
  );
}

export function extractWebQuery(msg = "") {
  const s = String(msg || "").trim();
  // Remove common prefixes like "search the web for"
  return s
    .replace(/^\s*(please\s+)?(can\s+you\s+)?(search\s+the\s+web|web\s+search|look\s+up|google|find\s+online)\s*(for)?\s*/i, "")
    .replace(/\s+for\s+me\s*$/i, "")
    .trim() || s.trim();
}
