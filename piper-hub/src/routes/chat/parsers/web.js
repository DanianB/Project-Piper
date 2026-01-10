// src/routes/chat/parsers/web.js
function isWebSearchIntent(msg) {
  const s = String(msg || "").trim().toLowerCase();
  return (
    s.startsWith("search the web") ||
    s.startsWith("search web") ||
    s.startsWith("web search") ||
    s.includes("search the web for") ||
    s.includes("look up ") ||
    s.includes("find online") ||
    s.includes("on the web")
  );
}

function extractWebQuery(msg) {
  const s = String(msg || "").trim();
  // Common patterns: "Search the web for X", "Look up X", "Find X online"
  let m = s.match(/search\s+(?:the\s+)?web\s+for\s+([\s\S]{1,200})/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");
  m = s.match(/look\s+up\s+([\s\S]{1,200})/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");
  m = s.match(/find\s+([\s\S]{1,200})\s+online/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");
  return s.slice(0, 200);
}

export { isWebSearchIntent, extractWebQuery };
