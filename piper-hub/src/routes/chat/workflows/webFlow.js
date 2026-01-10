// src/routes/chat/workflows/webFlow.js
import { runWebContext, extractWebSources, packSourcesForUi } from "../../../services/web/webContext.js";
import { isWebSearchIntent, extractWebQuery } from "../parsers/webIntent.js";

const EMPTY_SOURCES = { total: 0, shown: [], hidden: [] };

export async function maybeFetchWebContext(msg, sid) {
  let preToolResults = [];
  let webContext = null;
  if (isWebSearchIntent(msg)) {
    const q = extractWebQuery(msg);
    const ran = await runWebContext(q, sid);
    preToolResults = ran?.ran || [];
    webContext = ran?.fetchedText || null;
  }
  return { preToolResults, webContext };
}

export function augmentUserMessageWithWebContext(msg, webContext) {
  if (!webContext) return msg;
  return `${msg}\n\nWeb context:\n${webContext}`;
}

export function buildSourcesMeta(affect, preToolResults, toolResults, maxShown = 3) {
  const all = extractWebSources([...(preToolResults || []), ...(toolResults || [])]);
  const sources = packSourcesForUi(all, maxShown) || EMPTY_SOURCES;
  // Always include sources for UI consistency.
  return { affect, sources: sources.total >= 0 ? sources : EMPTY_SOURCES };
}
