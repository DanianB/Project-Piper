/**
 * src/services/web/webContext.js
 *
 * Thin, stable wrapper around Piper's tool registry web tools.
 * This module intentionally exports helpers used by chat.js and planners:
 * - webSearch(query, opts)
 * - webFetchText(url, opts)
 * - extractWebSources(toolRuns): normalize tool output into {total, shown, hidden}
 *
 * Why: The builtins web tool file is for tool registration and is not a
 * reliable place to import runtime helpers from (it may export nothing).
 */

import { toolRegistry } from "../../tools/registry.js";


function normalizeSearchQuery(input) {
  const s0 = String(input || "").trim();
  if (!s0) return "";
  let s = s0;

  // Strip common brevity/format constraints that harm search recall.
  s = s.replace(/(in\s+\d+\s+words?\s+or\s+less)/ig, "");
  s = s.replace(/(in\s+\d+\s+words?)/ig, "");
  s = s.replace(/(ten|10)\s+words?\s+or\s+less/ig, "");
  s = s.replace(/(briefly|concise|concisely|short|shortly|tl;dr|one\s+sentence|two\s+sentences)/ig, "");

  // Remove surrounding quotes and trailing punctuation.
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  s = s.replace(/[?.!]+$/g, "");

  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

function fallbackSearchQuery(q) {
  const s = normalizeSearchQuery(q);
  if (!s) return "";
  // If the query is long, try the first meaningful chunk before " in/with/for".
  const cut = s.split(/\b(?:in|with|for|about|please)\b/i)[0].trim();
  if (cut && cut.length >= 3) return cut;
  // Otherwise, use the first token.
  const tok = s.split(/\s+/)[0];
  return tok && tok.length >= 3 ? tok : s;
}

/** @typedef {{url?:string,title?:string,tool?:string,ok?:boolean,result?:any}} AnyToolResult */

/**
 * Get the registered web.search tool and run it.
 * @param {string} query
 * @param {{limit?:number, engine?:string, recencyDays?:number}} [opts]
 * @returns {Promise<{engine?:string, results:Array<{url:string,title?:string,snippet?:string}>}>}
 */
export async function webSearch(query, opts = {}) {
  const tool =
    toolRegistry?.get?.("web.search") || toolRegistry?.get?.("web.search_duckduckgo");
  if (!tool?.run) throw new Error("web.search tool is not registered");

  // Support both {limit} and older callers that pass {maxResults}.
  const limit = Number.isFinite(opts.limit)
    ? opts.limit
    : Number.isFinite(opts.maxResults)
    ? opts.maxResults
    : 5;

  // Keep args conservative so it matches your existing tool implementation.
  const args = { q: String(query || "").trim(), limit };
  if (opts.engine) args.engine = opts.engine;
  if (Number.isFinite(opts.recencyDays)) args.recencyDays = opts.recencyDays;

  const out = await tool.run(args);

  // Normalize: tool may return {engine, results} or {result:{...}}
  const payload = out?.result ?? out;
  const rawResults = Array.isArray(payload?.results) ? payload.results : [];

  // Normalize result urls so downstream code always finds them.
  const results = rawResults
    .filter(Boolean)
    .map((r) => ({
      ...r,
      url: r?.url || r?.href || r?.link || "",
    }))
    .filter((r) => r.url);

  return {
    engine: payload?.engine,
    results,
  };
}


/**
 * Fetch readable text from a URL using the registered web.fetch tool.
 * @param {string} url
 * @param {{maxChars?:number}} [opts]
 * @returns {Promise<{url:string, text:string}>}
 */
export async function webFetchText(url, opts = {}) {
  const tool = toolRegistry?.get?.("web.fetch") || toolRegistry?.get?.("web.open");
  if (!tool?.run) throw new Error("web.fetch tool is not registered");

  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 6000;

  const out = await tool.run({ url: String(url), maxChars });
  const payload = out?.result ?? out;

  return {
    url: String(url),
    text: String(payload?.text ?? payload?.content ?? ""),
  };
}

/**
 * Convert tool runs (whatever your planner records) into the "sources" meta object:
 * { total, shown: [{url,title}], hidden: [{url,title}] }
 *
 * Accepts:
 * - an array of tool call records
 * - an object with .shown/.hidden already
 * - a single web.search output
 *
 * @param {any} toolRuns
 * @returns {{total:number, shown:Array<{url:string,title?:string}>, hidden:Array<{url:string,title?:string}>}}
 */
export function extractWebSources(toolRuns) {
  // If already in the right shape, return a defensive clone
  if (toolRuns && typeof toolRuns === "object" && Array.isArray(toolRuns.shown) && Array.isArray(toolRuns.hidden)) {
    const shown = toolRuns.shown
      .filter(Boolean)
      .map((s) => ({ url: String(s.url || s.href || s.link || ""), title: s.title ? String(s.title) : undefined }))
      .filter((s) => s.url);
    const hidden = toolRuns.hidden
      .filter(Boolean)
      .map((s) => ({ url: String(s.url || s.href || s.link || ""), title: s.title ? String(s.title) : undefined }))
      .filter((s) => s.url);
    return { total: shown.length + hidden.length, shown, hidden };
  }

  const shown = [];
  const hidden = [];

  const pushResultList = (results, bucket) => {
    if (!Array.isArray(results)) return;
    for (const r of results) {
      const url = r?.url || r?.href || r?.link;
      if (!url) continue;
      bucket.push({ url: String(url), title: r?.title ? String(r.title) : undefined });
    }
  };

  const scanOne = (item) => {
    if (!item) return;

    // Common shape your app used earlier:
    // { tool: "web.search", ok: true, result: { engine, results: [...] } }
    if (item.tool === "web.search" || item.tool === "web.search_duckduckgo") {
      const payload = item.result ?? item;
      pushResultList(payload?.results, shown);
      return;
    }

    // Another possible shape: { engine, results: [...] }
    if (Array.isArray(item.results)) {
      pushResultList(item.results, shown);
      return;
    }

    // If a single result-like object
    if (item.url) {
      shown.push({ url: String(item.url), title: item.title ? String(item.title) : undefined });
    }
  };

  if (Array.isArray(toolRuns)) {
    for (const it of toolRuns) scanOne(it);
  } else {
    scanOne(toolRuns);
  }

  // De-dupe by URL (preserve order)
  const dedupe = (arr) => {
    const seen = new Set();
    const out = [];
    for (const s of arr) {
      const u = s.url;
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(s);
    }
    return out;
  };

  const shownDeduped = dedupe(shown);
  const hiddenDeduped = dedupe(hidden);

  return { total: shownDeduped.length + hiddenDeduped.length, shown: shownDeduped, hidden: hiddenDeduped };
}


// Back-compat helper: older chat.js expects a second packing step.
// If it's already packed ({total, shown, hidden}), return as-is.
export function packSourcesForUi(sourcesOrPacked, opts = {}) {
  if (!sourcesOrPacked) return { total: 0, shown: [], hidden: [] };
  if (
    typeof sourcesOrPacked === "object" &&
    "total" in sourcesOrPacked &&
    "shown" in sourcesOrPacked &&
    "hidden" in sourcesOrPacked
  ) {
    return sourcesOrPacked;
  }
  // If caller passed tool runs, pack from runs.
  if (Array.isArray(sourcesOrPacked) && sourcesOrPacked.length && sourcesOrPacked[0]?.tool) {
    return extractWebSources(sourcesOrPacked, opts);
  }
  // If caller passed an array of {title,url}, treat it as shown list.
  if (Array.isArray(sourcesOrPacked)) {
    const shown = sourcesOrPacked
      .filter((s) => s && (s.title || s.url))
      .map((s) => ({ title: String(s.title || s.url), url: s.url ? String(s.url) : "" }));
    return { total: shown.length, shown: shown.slice(0, opts.maxShown ?? 5), hidden: shown.slice(opts.maxShown ?? 5) };
  }
  return { total: 0, shown: [], hidden: [] };
}

// Runs a web search and returns tool-run records + a compact text blob suitable for an LLM.
export async function runWebContext(query, opts = {}) {
  const qRaw = String(query || "").trim();
  const q = normalizeSearchQuery(qRaw);
  const out = { ran: [], fetchedText: "" };
  if (!q) return out;

  let searchRes = await webSearch(q, { maxResults: opts.maxResults ?? 6 }).catch((e) => ({
    engine: "unknown",
    results: [],
    error: String(e?.message || e),
  }));

  out.ran.push({ tool: "web.search", ok: !searchRes?.error, result: searchRes });

// If the search came back empty, retry with a simplified query (often fixes "in N words" style prompts).
const results0 = Array.isArray(searchRes?.results) ? searchRes.results : [];
if (results0.length === 0) {
  const q2 = fallbackSearchQuery(qRaw);
  if (q2 && q2.toLowerCase() !== q.toLowerCase()) {
    const retry = await webSearch(q2, { maxResults: opts.maxResults ?? 6 }).catch((e) => ({
      engine: "unknown",
      results: [],
      error: String(e?.message || e),
    }));
    out.ran.push({ tool: "web.search", ok: !retry?.error, result: { ...retry, retryOf: q, query: q2 } });
    // Prefer retry results if better.
    if (Array.isArray(retry?.results) && retry.results.length) searchRes = retry;
  }
}


  // Prefer snippets; optionally fetch top N pages (off by default for stability).
  const results = Array.isArray(searchRes?.results) ? searchRes.results : [];
  const top = results.slice(0, opts.fetchTopN ?? 0);

  const snippetText = results
    .slice(0, opts.maxResultsForText ?? 6)
    .map((r, i) => {
      const title = r?.title ? String(r.title) : "";
      const url = r?.url ? String(r.url) : "";
      const snippet = r?.snippet ? String(r.snippet) : "";
      return `[#${i + 1}] ${title}\n${url}\n${snippet}`.trim();
    })
    .filter(Boolean)
    .join("\n\n");

  let fetched = "";
  if (top.length) {
    const fetchedParts = [];
    for (const r of top) {
      const url = r?.url ? String(r.url) : "";
      if (!url) continue;
      const txt = await webFetchText(url).catch(() => "");
      if (txt) fetchedParts.push(`URL: ${url}\n${txt}`);
      // Record fetch run so UI can show sources even if fetch fails later.
      out.ran.push({ tool: "web.fetch", ok: Boolean(txt), result: { url, text: txt ? txt.slice(0, 2000) : "" } });
    }
    fetched = fetchedParts.join("\n\n").slice(0, opts.maxChars ?? 6000);
  }

  out.fetchedText = (fetched || snippetText).slice(0, opts.maxChars ?? 6000);
  return out;
}
