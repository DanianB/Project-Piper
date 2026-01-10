// src/routes/chat/webSources.js
// Phase 2.1: Provide non-spoken sources for UI when web.search/web.fetch were used.
// Returned format: [{ url, title }]

function normalizeUrl(u) {
  try {
    const url = new URL(String(u));
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function extractWebSources(toolResults) {
  const out = [];
  const seen = new Set();

  const push = (url, title) => {
    const nu = normalizeUrl(url);
    if (!nu || seen.has(nu)) return;
    seen.add(nu);
    out.push({ url: nu, title: String(title || nu) });
  };

  for (const tr of Array.isArray(toolResults) ? toolResults : []) {
    if (!tr?.ok) continue;
    const tool = String(tr.tool || tr.id || "");
    const r = tr.result || tr.data || tr.output;
    if (!r) continue;

    if (tool === "web.search") {
      const results = Array.isArray(r.results)
        ? r.results
        : Array.isArray(r)
          ? r
          : [];
      for (const item of results) push(item?.url, item?.title);

      // If the engine returns no structured results, still show a stable "search" source
      // so the UI doesn't render "Undefined" entries.
      if (results.length === 0 && r?.query) {
        const q = encodeURIComponent(String(r.query));
        push(`https://duckduckgo.com/?q=${q}`, `Search: ${String(r.query)}`);
      }
    } else if (tool === "web.fetch") {
      push(r?.url || r?.finalUrl, r?.title);
    }
  }

  return out;
}

export function packSourcesForUi(sources, maxShown = 3) {
  const list = Array.isArray(sources) ? sources : [];
  return { total: list.length, shown: list.slice(0, maxShown), hidden: list.slice(maxShown) };
}
