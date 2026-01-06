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
  // Each model entry generally has .name
  const names = models
    .map((m) => m?.name)
    .filter((n) => typeof n === "string" && n.trim());
  return names;
}

async function pickInstalledModel(preferred) {
  // Avoid hammering /api/tags; refresh at most every 10s unless forced by error.
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

    // If preferred is installed, use it; otherwise first available.
    if (preferred && names.includes(preferred)) {
      cachedModelName = preferred;
    } else {
      cachedModelName = names[0];
    }
  }

  return cachedModelName;
}

function looksLikeModelNotFound(status, bodyText) {
  if (status !== 404) return false;
  const t = String(bodyText || "").toLowerCase();
  return t.includes("model") && t.includes("not found");
}

/**
 * Call Ollama /api/chat
 * - Supports forcing JSON output via opts.format="json"
 * - Auto-falls back to an installed model if requested model is missing
 * - Does NOT silently swallow errors (logs + throws)
 */
export async function callOllama(messages, opts = {}) {
  const {
    timeoutMs = 60000,
    model = process.env.OLLAMA_MODEL || null,
    format = null, // "json" to force JSON output
    temperature = 0.2,
  } = opts;

  if (!Array.isArray(messages)) {
    throw new Error("callOllama: messages must be an array of {role, content}");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  // We'll try at most twice:
  // 1) requested model (or cached/installed pick)
  // 2) fallback installed model if the first was "model not found"
  const preferred = model && String(model).trim() ? String(model).trim() : null;

  // If user didn't specify anything, pick an installed model.
  let chosenModel = preferred || (cachedModelName ? cachedModelName : null);
  if (!chosenModel) {
    chosenModel = await pickInstalledModel(preferred);
  }

  async function doCall(modelName) {
    const body = {
      model: modelName,
      messages,
      stream: false,
      options: { temperature },
    };

    // Ollama supports `format: "json"` on /api/chat for constrained JSON output
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

    // If successful, remember the model used.
    cachedModelName = modelName;
    return content;
  }

  try {
    try {
      return await doCall(chosenModel);
    } catch (e) {
      // If the model wasn't found, refresh tags and retry with a real installed model.
      const status = e?.status;
      const bodyText = e?.bodyText;
      if (looksLikeModelNotFound(status, bodyText)) {
        // Force refresh installed model list
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
    console.error("[ollama] call failed:", e?.message || e);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
