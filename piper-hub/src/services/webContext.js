import { initSources, extractWebSources, mergeSources, toolCallRecord } from "./sources.js";

/**
 * Runs a web search and (optionally) fetches a couple pages to provide grounding text.
 * Returns { ok, contextText, sources } where `sources` is always present.
 */
export async function runWebContext(toolRegistry, query, opts = {}) {
  const { fetchTop = 2, maxChars = 12000 } = opts;
  const sources = initSources();

  // 1) Search
  const searchRes = await toolRegistry.invoke("web.search", { query });
  // Keep the tool call record (hidden) for debugging
  mergeSources(sources, {
    hidden: [toolCallRecord("web.search", searchRes?.ok, searchRes?.result)],
  });

  const found = extractWebSources(searchRes);
  if (found.length) {
    // Show up to 5 in UI; keep the rest hidden.
    mergeSources(sources, { shown: found.slice(0, 5), hidden: found.slice(5) });
  }

  if (!searchRes?.ok || found.length === 0) {
    return { ok: false, contextText: "", sources };
  }

  // 2) Fetch top pages for grounding (best-effort)
  const urls = found.map((s) => s.url).filter(Boolean).slice(0, fetchTop);
  let chunks = [];
  for (const url of urls) {
    try {
      const fetchRes = await toolRegistry.invoke("web.fetch", { url });
      mergeSources(sources, {
        hidden: [toolCallRecord("web.fetch", fetchRes?.ok, { url, ...(fetchRes?.result || {}) })],
      });
      const text = fetchRes?.result?.text || fetchRes?.result?.content || "";
      if (fetchRes?.ok && text) {
        chunks.push(text);
      }
    } catch {
      // ignore; keep going
    }
  }

  const combined = chunks.join("\n\n").slice(0, maxChars);
  return { ok: combined.length > 0, contextText: combined, sources };
}
