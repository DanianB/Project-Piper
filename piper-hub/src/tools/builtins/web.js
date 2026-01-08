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
        // DDG blocks many "bot-looking" agents; mimic a real browser.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
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

function decodeDuckDuckGoUrl(href) {
  try {
    if (!href) return href;
    if (href.startsWith("//")) return "https:" + href;

    // DDG sometimes wraps outbound links like /l/?uddg=<encoded>
    if (href.startsWith("/l/?")) {
      const u = new URL("https://duckduckgo.com" + href);
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    return href;
  } catch {
    return href;
  }
}

function parseDuckDuckGoHtml(htmlText, maxResults) {
  const out = [];
  const s = String(htmlText || "");
  const aRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = aRe.exec(s)) && out.length < maxResults) {
    const rawHref = stripHtml(m[1] || "").trim();
    const url = decodeDuckDuckGoUrl(rawHref);
    const title = stripHtml(m[2] || "").trim();

    const after = s.slice(aRe.lastIndex, aRe.lastIndex + 2000);
    const snipM = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(after);
    const snippet = stripHtml(snipM?.[1] || "").trim();

    if (!title || !url) continue;
    if (out.some((r) => r.url === url)) continue;

    out.push({ title, url, snippet });
  }
  return out;
}

function parseDuckDuckGoLite(htmlText, maxResults) {
  const out = [];
  const s = String(htmlText || "");
  const aRe = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = aRe.exec(s)) && out.length < maxResults) {
    const rawHref = stripHtml(m[1] || "").trim();
    const url = decodeDuckDuckGoUrl(rawHref);
    const title = stripHtml(m[2] || "").trim();
    if (!title || !url) continue;
    if (out.some((r) => r.url === url)) continue;
    out.push({ title, url, snippet: "" });
  }
  return out;
}

function looksLikeDdgChallenge(htmlText) {
  const s = String(htmlText || "").toLowerCase();
  // Heuristics: JS/captcha/verify pages often have these tokens.
  return (
    s.includes("enable javascript") ||
    s.includes("captcha") ||
    s.includes("verify you are") ||
    s.includes("unusual traffic") ||
    s.includes("please wait") ||
    s.includes("ddg-privacy") && s.length < 20000
  );
}

async function ddgInstantAnswer(query, maxResults) {
  const q = encodeURIComponent(query);
  const url = `https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const r = await fetchWithLimits(url, { timeoutMs: 12000, maxBytes: 1_500_000 });
  if (!r.ok) return [];

  let data = null;
  try {
    data = JSON.parse(r.text);
  } catch {
    return [];
  }

  const out = [];
  const push = (u, t) => {
    if (!u || !t) return;
    if (out.some((x) => x.url === u)) return;
    out.push({ url: u, title: t, snippet: "" });
  };

  if (Array.isArray(data?.Results)) {
    for (const it of data.Results) {
      if (out.length >= maxResults) break;
      push(it?.FirstURL, it?.Text);
    }
  }

  const walk = (node) => {
    if (!node || out.length >= maxResults) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node?.FirstURL && node?.Text) push(node.FirstURL, node.Text);
    if (Array.isArray(node?.Topics)) walk(node.Topics);
  };

  if (Array.isArray(data?.RelatedTopics)) walk(data.RelatedTopics);
  return out.slice(0, maxResults);
}

function heuristicKnownDocs(query, maxResults) {
  const q = String(query || "").toLowerCase();
  const out = [];
  const push = (url, title) => out.push({ url, title, snippet: "" });

  // Targeted "official docs" fallbacks for common dev queries (avoids empty sources if search engine blocks).
  if (q.includes("spotify") && (q.includes("web api") || q.includes("spotify api") || q.includes("authorization") || q.includes("auth"))) {
    push("https://developer.spotify.com/documentation/web-api", "Spotify Web API Documentation");
    push("https://developer.spotify.com/documentation/web-api/concepts/authorization", "Spotify Web API — Authorization Guide");
    push("https://accounts.spotify.com/authorize", "Spotify Accounts — Authorize Endpoint");
    push("https://accounts.spotify.com/api/token", "Spotify Accounts — Token Endpoint");
  }

  return out.slice(0, maxResults);
}

toolRegistry.register({
  id: "web.search",
  description: "Search the web for a query. Returns title/url/snippet results.",
  risk: ToolRisk.READ_ONLY,
  validateArgs: (args) => {
    const query = String(args?.query || "").trim();
    const maxResults = clampInt(args?.maxResults, 1, 10, 5);
    if (!query) return { ok: false, error: "Missing query" };
    return { ok: true, value: { query, maxResults } };
  },
  handler: async ({ args }) => {
    const query = String(args?.query || "").trim();
    const maxResults = clampInt(args?.maxResults, 1, 10, 5);
    const q = encodeURIComponent(query);

    const attempts = [
      { url: `https://duckduckgo.com/html/?q=${q}`, engine: "duckduckgo_html" },
      { url: `https://html.duckduckgo.com/html/?q=${q}`, engine: "duckduckgo_html_alt" },
      { url: `https://lite.duckduckgo.com/lite/?q=${q}`, engine: "duckduckgo_lite" },
    ];

    let lastErr = null;
    for (const a of attempts) {
      try {
        const r = await fetchWithLimits(a.url, { timeoutMs: 12000, maxBytes: 1_500_000 });

        // Keep console logs short + consistent (you already rely on these).
        console.log("[WEB] search", { engine: a.engine, status: r.status, ok: r.ok, bytes: r.bytes });

        // If DDG gives a challenge page, don't bother parsing.
        const challenged = r.status === 202 || looksLikeDdgChallenge(r.text);
        const results =
          challenged
            ? []
            : a.engine === "duckduckgo_lite"
              ? parseDuckDuckGoLite(r.text, maxResults)
              : parseDuckDuckGoHtml(r.text, maxResults);

        if (Array.isArray(results) && results.length) {
          return { query, engine: a.engine, results };
        }
      } catch (e) {
        lastErr = e;
      }
    }

    // Fallback 1: DDG Instant Answer API (often works when HTML is challenged)
    try {
      const ia = await ddgInstantAnswer(query, maxResults);
      if (ia.length) return { query, engine: "duckduckgo_instant_answer", results: ia };
    } catch (e) {
      lastErr = lastErr || e;
    }

    // Fallback 2: heuristic known official docs for common queries
    const heur = heuristicKnownDocs(query, maxResults);
    if (heur.length) return { query, engine: "heuristic_docs", results: heur };

    return {
      query,
      engine: "web.search",
      results: [],
      error: lastErr ? String(lastErr?.message || lastErr) : "No results parsed",
    };
  },
});

toolRegistry.register({
  id: "web.fetch",
  description: "Fetch a web page (http/https) and return sanitized text (best-effort). Blocks localhost. Size/timeout limited.",
  risk: ToolRisk.READ_ONLY,
  validateArgs: (args) => {
    const url = String(args?.url || "").trim();
    const maxChars = clampInt(args?.maxChars, 2000, 80000, 20000);
    if (!url) return { ok: false, error: "Missing url" };
    if (!isSafeHttpUrl(url)) return { ok: false, error: "URL not allowed (only public http/https)" };
    return { ok: true, value: { url, maxChars } };
  },
  handler: async ({ args }) => {
    const url = String(args?.url || "").trim();
    const maxChars = clampInt(args?.maxChars, 2000, 80000, 20000);

    const r = await fetchWithLimits(url, { timeoutMs: 15000, maxBytes: 2_000_000 });
    const ct = String(r.contentType || "");
    const raw = String(r.text || "");

    const text = ct.includes("text/html")
      ? stripHtml(raw)
      : raw.replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();

    const trimmed =
      text.length > maxChars ? text.slice(0, maxChars) + `...(+${text.length - maxChars} chars)` : text;

    return { url, status: r.status, ok: r.ok, contentType: ct, text: trimmed };
  },
});
