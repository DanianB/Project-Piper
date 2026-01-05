// src/services/ollama.js
function safeJsonParse(s) {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object") return v;
    return null;
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

/**
 * Call Ollama /api/chat
 * - Supports forcing JSON output via opts.format="json"
 * - Does NOT silently swallow errors (logs + throws)
 */
export async function callOllama(messages, opts = {}) {
  const {
    timeoutMs = 60000,
    model = process.env.OLLAMA_MODEL || "llama3",
    format = null, // "json" to force JSON output
    temperature = 0.2,
  } = opts;

  if (!Array.isArray(messages)) {
    throw new Error("callOllama: messages must be an array of {role, content}");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  const body = {
    model,
    messages,
    stream: false,
    options: { temperature },
  };

  // Ollama supports `format: "json"` on /api/chat for constrained JSON output
  if (format === "json") body.format = "json";

  try {
    const r = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Ollama HTTP ${r.status}: ${txt.slice(0, 500)}`);
    }

    const data = await r.json().catch(() => null);
    const content = data?.message?.content;

    if (typeof content !== "string") {
      throw new Error(
        `Ollama response missing message.content (got keys: ${
          data ? Object.keys(data).join(",") : "null"
        })`
      );
    }

    return content;
  } catch (e) {
    console.error("[ollama] call failed:", e?.message || e);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
