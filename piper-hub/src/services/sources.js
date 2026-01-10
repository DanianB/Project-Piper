/**
 * Sources helpers used for UI rendering of "Sources" under replies.
 * Keep this module tiny + stable to avoid breaking chat flow.
 */

export function initSources() {
  return { total: 0, shown: [], hidden: [] };
}

/**
 * Extracts search result-like sources from one toolResult or an array of toolResults.
 * Currently supports the shape returned by our `web.search` tool: { result: { results: [{href,title,snippet?}, ...] } }
 */
export function extractWebSources(toolResults) {
  const arr = Array.isArray(toolResults) ? toolResults : [toolResults];
  const all = [];

  for (const toolResult of arr) {
    try {
      const r = toolResult?.result;
      const results = Array.isArray(r?.results) ? r.results : [];
      const out = results
        .map((x) => {
          const url = x?.href || x?.url || x?.link;
          const title = x?.title || x?.name;
          const snippet = x?.snippet || x?.body || x?.description;
          return url || title ? { url, title, snippet } : null;
        })
        .filter(Boolean);
      all.push(...out);
    } catch {
      // ignore
    }
  }

  return all;
}

export function mergeSources(base, add) {
  const out = base || initSources();
  const shown = Array.isArray(add?.shown) ? add.shown : [];
  const hidden = Array.isArray(add?.hidden) ? add.hidden : [];
  out.shown = [...(out.shown || []), ...shown].filter(Boolean);
  out.hidden = [...(out.hidden || []), ...hidden].filter(Boolean);
  out.total = (out.shown?.length || 0) + (out.hidden?.length || 0);
  return out;
}

/**
 * Records a tool call for transparency/debug in meta.sources.hidden.
 */
export function toolCallRecord(toolName, ok, result, extra = {}) {
  return { tool: toolName, ok: !!ok, result, ...extra };
}
