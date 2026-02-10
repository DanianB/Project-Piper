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

// ---- Ollama model discovery + caching ----
const OLLAMA_BASE_URL = process.env.OLLAMA_URL || "http://localhost:11434";
let cachedModelName = null;
let lastTagsFetchAt = 0;


function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readTimeoutMs(fallbackMs) {
  const raw = process.env.OLLAMA_TIMEOUT_MS;
  if (!raw) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 1000 ? n : fallbackMs;
}

async function fetchTags() {
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
  const shouldRefresh = !cachedModelName || now - lastTagsFetchAt > 10_000;

  if (shouldRefresh) {
    const names = await fetchTags();
    lastTagsFetchAt = now;

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
 */
export async function callOllama(messages, opts = {}) {
  const {
    // Planner calls can be slow; default to 180s. Override via OLLAMA_TIMEOUT_MS.
    timeoutMs = readTimeoutMs(180_000),
    model = process.env.OLLAMA_MODEL || null,
    format = null, // "json"
    temperature = 0.2,
    // Optional speed controls
    numPredict = readIntEnv("OLLAMA_NUM_PREDICT", null),
    keepAlive = process.env.OLLAMA_KEEP_ALIVE || null,
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

  async function doCall(modelName) {
    const body = {
      model: modelName,
      messages,
      stream: false,
      options: { temperature, num_predict: numPredict },
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

    cachedModelName = modelName;
    return content;
  }

  try {
    try {
      return await doCall(chosenModel);
    } catch (e) {
      // Clean timeout error instead of raw AbortError noise
      if (isAbortError(e)) {
        throw new Error(
          `Ollama request timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            `Increase OLLAMA_TIMEOUT_MS or use a faster model.`
        );
      }

      // If model missing, refresh and retry once using installed model.
      const status = e?.status;
      const bodyText = e?.bodyText;

      if (looksLikeModelNotFound(status, bodyText)) {
        cachedModelName = null;
        lastTagsFetchAt = 0;

        const fallback = await pickInstalledModel(preferred);
        console.warn(
          `[ollama] model not found: "${e?.modelName}". Falling back to installed model: "${fallback}".`
        );
        return await doCall(fallback);
      }

      throw e;
    }
  } catch (e) {
    // Avoid printing scary stack traces for timeouts unless you want them
    console.error("[ollama] call failed:", e?.message || e);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
