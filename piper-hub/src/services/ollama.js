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

  // Try to find a JSON object anywhere in the string
  const start = s.indexOf("{");
  if (start < 0) return null;

  for (let i = start; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === "{") depth++;
      if (c === "}") depth--;
      if (depth === 0) {
        const cand = s.slice(i, j + 1);
        const parsed = safeJsonParse(cand);
        if (parsed) return parsed;
        break;
      }
    }
  }
  return null;
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";

let cachedModelName = null;
let lastTagsFetchAt = 0;

function readTimeoutMs(defaultMs) {
  const raw = process.env.OLLAMA_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return defaultMs;
}

async function fetchInstalledModels() {
  const r = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Ollama tags HTTP ${r.status}: ${txt.slice(0, 500)}`);
  }

  const j = await r.json().catch(() => null);
  const models = Array.isArray(j?.models) ? j.models : [];
  const names = models
    .map((m) => m?.name)
    .filter((n) => typeof n === "string" && n.trim());
  return names;
}

async function pickInstalledModel(preferred) {
  const now = Date.now();
  const age = now - lastTagsFetchAt;

  if (!cachedModelName || age > 30_000) {
    lastTagsFetchAt = now;
    const names = await fetchInstalledModels();

    if (!names.length) {
      throw new Error(
        "Ollama has no installed models. Run `ollama list` and pull a model, e.g. `ollama pull llama3`."
      );
    }

    if (preferred && names.includes(preferred)) cachedModelName = preferred;
    else cachedModelName = names[0];
  }

  return cachedModelName;
}

function looksLikeModelNotFound(status, bodyText) {
  if (status !== 404) return false;
  const t = String(bodyText || "").toLowerCase();
  return t.includes("model") && t.includes("not found");
}

function isAbortError(e) {
  const msg = String(e?.message || "");
  return (
    e?.name === "AbortError" ||
    msg.includes("aborted") ||
    msg.includes("This operation was aborted")
  );
}

/**
 * Call Ollama /api/chat
 * - Auto-falls back to installed model if requested model is missing
 * - Timeout is configurable via OLLAMA_TIMEOUT_MS (default 180s)
 * - Keeps model warm via keep_alive (default 10m; set OLLAMA_KEEP_ALIVE)
 */
export async function callOllama(messages, opts = {}) {
  const {
    timeoutMs = readTimeoutMs(180_000),
    model = process.env.OLLAMA_MODEL || null,
    format = null, // "json"
    temperature = 0.2,
  } = opts;

  if (!Array.isArray(messages)) {
    throw new Error("callOllama: messages must be an array of {role, content}");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  const preferred = model && String(model).trim() ? String(model).trim() : null;

  let chosenModel = preferred || (cachedModelName ? cachedModelName : null);
  if (!chosenModel) chosenModel = await pickInstalledModel(preferred);

  async function tryOnce(modelName) {
    const body = {
      model: modelName,
      // BIG latency win if you were paying cold starts:
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || "10m",
      messages,
      stream: false,
      options: { temperature },
    };
    if (format === "json") body.format = "json";

    const r = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      const err = new Error(`Ollama HTTP ${r.status}: ${txt.slice(0, 500)}`);
      err.status = r.status;
      err.bodyText = txt;
      err.modelName = modelName;
      throw err;
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
  }

  try {
    return await tryOnce(chosenModel);
  } catch (e) {
    if (isAbortError(e)) {
      throw new Error(`Ollama timed out after ${timeoutMs}ms`);
    }

    const status = e?.status;
    const bodyText = e?.bodyText;

    if (looksLikeModelNotFound(status, bodyText)) {
      cachedModelName = null;
      lastTagsFetchAt = 0;

      const fallback = await pickInstalledModel(preferred);
      console.warn(
        `[ollama] model not found: "${e?.modelName}". Falling back to installed model: "${fallback}".`
      );
      return await tryOnce(fallback);
    }

    throw e;
  } finally {
    clearTimeout(timer);
  }
}
