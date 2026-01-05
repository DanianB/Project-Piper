export async function callOllama(messages, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  try {
    const r = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama3", messages, stream: false }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Ollama HTTP ${r.status}: ${txt.slice(0, 300)}`);
    }
    const j = await r.json();
    return j.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

export function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function extractFirstJsonObject(s) {
  s = String(s || "").trim();
  const direct = safeJsonParse(s);
  if (direct) return direct;
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return safeJsonParse(s.slice(start, end + 1));
  return null;
}
