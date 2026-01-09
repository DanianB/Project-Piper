// src/tools/builtins/web.js
import { toolRegistry, ToolRisk } from "../registry.js";

function clampInt(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(x)));
}

function isSafeHttpUrl(u) {
  try {
    const url = new URL(String(u || ""));
    if (!["http:", "https:"].includes(url.protocol)) return false;
    // Block localhost / private ranges by default
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    return true;
  } catch {
    return false;
  }
}

function stripHtml(html) {
  const s = String(html || "");
  // Remove script/style
  let t = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  // Tags -> spaces
  t = t.replace(/<[^>]+>/g, " ");
  // Basic entity decoding (minimal)
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  // Collapse whitespace
  t = t.replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return t;
}

async function fetchWithLimits(url, { timeoutMs = 12000, maxBytes = 1_500_000 } = {}) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "PiperHub/0.9 (local; +https://localhost)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
    });

    const ct = String(res.headers.get("content-type") || "");
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      return { status: res.status, ok: res.ok, contentType: ct, bytes: text.length, text };
    }

    let received = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          controller.abort();
          throw new Error(`Response too large (>${maxBytes} bytes)`);
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return { status: res.status, ok: res.ok, contentType: ct, bytes: received, text };
  } finally {
    clearTimeout(to);
  }
}

function parseDuckDuckGoHtml(html, maxResults) {
  const out = [];
  const s = String(html || "");
  // DuckDuckGo HTML results page contains anchors with class "result__a"
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>|<div[^>]*class="result__snippet"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi;
  let m;
  while ((m = re.exec(s)) && out.length < maxResults) {
    const url = stripHtml(m[1]);
    const title = stripHtml(m[2]);
    const snippet = stripHtml(m[3]);
    if (!url || !title) continue;
    out.push({ title, url, snippet });
  }

  // Fallback: if snippet regex fails, at least capture titles/urls
  if (out.length === 0) {
    const re2 = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re2.exec(s)) && out.length < maxResults) {
      const url = stripHtml(m[1]);
      const title = stripHtml(m[2]);
      if (!url || !title) continue;
      out.push({ title, url, snippet: "" });
    }
  }
  return out;
}

toolRegistry.register({
  id: "web.search",
  description: "Search the web for a query (DuckDuckGo HTML). Returns title/url/snippet results.",
  risk: ToolRisk.READ_ONLY,
  inputSchema: (args) => {
    const query = String(args?.query || "").trim();
    const maxResults = clampInt(args?.maxResults, 1, 10, 5);
    if (!query) return { ok: false, error: "Missing query" };
    return { ok: true, value: { query, maxResults } };
  },
  handler: async ({ query, maxResults }) => {
    const q = encodeURIComponent(query);
    const url = `https://duckduckgo.com/html/?q=${q}`;
    const r = await fetchWithLimits(url, { timeoutMs: 12000, maxBytes: 1_500_000 });
    const results = parseDuckDuckGoHtml(r.text, maxResults);
    return { query, engine: "duckduckgo_html", results };
  },
});

toolRegistry.register({
  id: "web.fetch",
  description: "Fetch a web page (http/https) and return sanitized text (best-effort). Blocks localhost. Size/timeout limited.",
  risk: ToolRisk.READ_ONLY,
  inputSchema: (args) => {
    const url = String(args?.url || "").trim();
    const maxChars = clampInt(args?.maxChars, 2000, 80000, 20000);
    if (!url) return { ok: false, error: "Missing url" };
    if (!isSafeHttpUrl(url)) return { ok: false, error: "URL not allowed (only public http/https)" };
    return { ok: true, value: { url, maxChars } };
  },
  handler: async ({ url, maxChars }) => {
    const r = await fetchWithLimits(url, { timeoutMs: 15000, maxBytes: 2_000_000 });
    const ct = String(r.contentType || "");
    const raw = String(r.text || "");
    const text = ct.includes("text/html") ? stripHtml(raw) : raw.replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
    const trimmed = text.length > maxChars ? text.slice(0, maxChars) + `...(+${text.length - maxChars} chars)` : text;
    return { url, status: r.status, ok: r.ok, contentType: ct, text: trimmed };
  },
});
