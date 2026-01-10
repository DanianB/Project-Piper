// src/routes/chat/workflows/plannerFlow.js
import crypto from "crypto";

import { buildSnapshot } from "../../../planner/snapshot.js";
import { llmRespondAndPlan } from "../../../planner/planner.js";
import { compilePlanToActions } from "../../../planner/compiler.js";

import { listTools } from "../../../tools/index.js";
import { toolRegistry, ToolRisk } from "../../../tools/registry.js";

import { addAction } from "../../../actions/store.js";
import { logRunEvent } from "../../../utils/runlog.js";

/**
 * Runs Phase 3 planner flow (triage already decided mode !== "chat").
 *
 * Returns the standard response body:
 * { reply, emotion, intensity, proposed, meta }
 */
export async function runPlannerFlow({
  sid,
  msg,
  sessions,
  started,
  // injected helpers from chat.js to avoid circular deps
  pickEmotion,
  getAffectSnapshot,
  setLastIntent,
  recordEvent,
  buildSourcesMeta,
  enforcePiper,
}) {
  const snapshot = await buildSnapshot({
    message: msg,
    lastIntent: sessions.get(sid)?.lastIntent || "chat",
  });

  const availableTools = listTools();

  // Phase 1.1: deterministic grounding for code-location questions
  const deriveLocationQuery = (text) => {
    const s = String(text || "");
    const hasWhereWords = /(\bwhere\b|\blocated\b|\bdefined\b|\bdefinition\b|\bset\b|\bstored\b)/i.test(
      s
    );
    if (!hasWhereWords) return null;

    // Only treat this as a repo/code location question if it has clear code/identifier signals.
    const hasCodeContext =
      /(\bfile\b|\bfiles\b|\brepo\b|\bcode\b|\bconstant\b|\bconfig\b|\bsetting\b|\bvariable\b|\broute\b|\bmodule\b|\bimport\b|\bexport\b|\bpath\b|\bline\b)/i.test(
        s
      );
    const backtick = s.match(/`([^`]{2,64})`/);
    const fileLike = s.match(/\b([a-zA-Z0-9_\\/\.-]+\.(?:js|ts|json|py|css|html))\b/i);
    const allCaps = s.match(/\b[A-Z][A-Z0-9_]{2,64}\b/);
    const voiceMention = /voice[_\s]?choices/i.test(s);
    const nameMention = /your\s+name/i.test(s);
    const identifierLike =
      Boolean(backtick) ||
      Boolean(fileLike) ||
      (Boolean(allCaps) && String(allCaps?.[0] || "").includes("_")) ||
      voiceMention ||
      nameMention;

    if (!(hasCodeContext || identifierLike)) return null;

    let q = backtick?.[1] || fileLike?.[1] || allCaps?.[0] || null;
    if (!q && nameMention) q = "Piper";
    if (!q && voiceMention) q = "VOICE_CHOICES";
    if (!q) {
      const id = s.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,64}\b/);
      q = id?.[0] || null;
    }
    return q;
  };

  let preToolResults = null;
  const locationQuery = deriveLocationQuery(msg);
  if (locationQuery && availableTools.some((t) => t.id === "repo.searchText")) {
    const r = await toolRegistry.run({
      id: "repo.searchText",
      args: { query: locationQuery, maxResults: 25 },
      context: { sid },
    });
    preToolResults = [
      { tool: "repo.searchText", ok: r.ok, error: r.error, result: r.result },
    ];
    logRunEvent("tool_call_forced", {
      sid,
      tool: "repo.searchText",
      query: locationQuery,
      ok: r.ok,
    });
  }

  // If we forced a location query search, respond deterministically (so the model can’t dodge grounding).
  if (locationQuery && Array.isArray(preToolResults) && preToolResults[0]?.ok) {
    const matches = preToolResults[0]?.result?.matches;
    if (Array.isArray(matches)) {
      const total = matches.length;
      if (total === 0) {
        const affect = getAffectSnapshot(sid);
        return {
          reply: enforcePiper(
            `I searched the repository for "${locationQuery}" and found no matches.`
          ),
          emotion: "confident",
          intensity: 0.45,
          proposed: [],
          meta: {
            affect,
            locationMatches: {
              query: locationQuery,
              total: 0,
              shown: [],
              hidden: [],
            },
          },
        };
      }

      const shown = matches.slice(0, 3);
      const hidden = matches.slice(3);
      const fmt = (m) =>
        `${m.file}:${m.line}:${m.col} ${String(m.preview || "").trim()}`;
      const lines = [];
      lines.push(
        `I searched the repository for "${locationQuery}" and found ${total} match(es).`
      );
      lines.push("Top results:");
      for (const m of shown) lines.push(`- ${fmt(m)}`);
      if (hidden.length > 0)
        lines.push(`(${hidden.length} more hidden — click “Show more”.)`);
      lines.push(
        "If you want, ask me to open one of these files and I can show the exact definition in context."
      );

      const affect = getAffectSnapshot(sid);
      return {
        reply: enforcePiper(lines.join("\n")),
        emotion: "confident",
        intensity: 0.45,
        proposed: [],
        meta: { affect, locationMatches: { query: locationQuery, total, shown, hidden } },
      };
    }
  }

  let planned = await llmRespondAndPlan({
    message: msg,
    snapshot,
    lastIntent: sessions.get(sid)?.lastIntent || "chat",
    availableTools,
    toolResults: preToolResults,
  });

  // If we forced a repo.searchText and found no matches, do not let the model guess.
  if (locationQuery && Array.isArray(preToolResults) && preToolResults[0]?.ok) {
    const m = preToolResults[0]?.result?.matches;
    if (Array.isArray(m) && m.length === 0) {
      planned = {
        reply: `I searched the repository for "${locationQuery}" and found no matches. It may be generated at runtime, injected from environment/config outside the repo, or spelled differently. If you tell me where you saw it (file/snippet), I can trace it.`,
        requiresApproval: false,
        toolCalls: [],
        ops: [],
      };
    }
  }

  // --- Tool pass (read-only tools only) ---
  const toolCalls = Array.isArray(planned?.toolCalls) ? planned.toolCalls : [];

  // If the model did not request tools but the user is asking for a code/config location,
  // force a read-only repo search so we don't hallucinate.
  if (toolCalls.length === 0) {
    const s = String(msg || "");
    const looksLikeLocationQuestion = (() => {
      const t = String(s || "");
      const hasWhereWords =
        /(\bwhere\b|\blocated\b|\bdefined\b|\bdefinition\b|\bset\b|\bstored\b)/i.test(
          t
        );
      if (!hasWhereWords) return false;

      // If the user mentions an identifier-like token (e.g. VOICE_CHOICES), force grounding.
      const hasIdentifier =
        /\b[A-Z][A-Z0-9_]{2,}\b/.test(t) || /\bvoice[_\s]?choices\b/i.test(t);

      // Or they explicitly ask about repo/file/code locations.
      const hasCodeContext =
        /(\bfile\b|\bfiles\b|\brepo\b|\bcode\b|\bconstant\b|\bconfig\b|\bsetting\b|\bvariable\b|\bname\b)/i.test(
          t
        );

      return hasIdentifier || hasCodeContext;
    })();

    if (
      looksLikeLocationQuestion &&
      availableTools.some((t) => t.id === "repo.searchText")
    ) {
      // Prefer explicit identifiers if present: `LIKE_THIS` or ALL_CAPS tokens.
      const backtick = s.match(/`([^`]{2,64})`/);
      const allCaps = s.match(/\b[A-Z][A-Z0-9_]{2,64}\b/);
      let query =
        backtick?.[1] ||
        allCaps?.[0] ||
        (String(s).match(/\b[A-Z][A-Z0-9_]{2,}\b/) || [])[0] ||
        null;

      if (!query && /your\s+name/i.test(s)) query = "Piper";
      if (!query && /voice_choices|voice choices/i.test(s))
        query = "VOICE_CHOICES";
      if (!query) query = s.slice(0, 120);

      toolCalls.push({
        tool: "repo.searchText",
        args: { query, maxResults: 20 },
        why: "User asked where something is defined/located; grounding required.",
      });

      logRunEvent("tool_call_forced", { sid, tool: "repo.searchText", query });
    }
  }

  // Always treat as array
  let toolResults = [];

  if (toolCalls.length > 0) {
    const limited = toolCalls.slice(0, 3);

    for (const tc of limited) {
      const toolId = String(tc?.tool || "");
      const args = tc?.args || {};
      const why = String(tc?.why || "");

      const tool = toolRegistry.get(toolId);
      if (!tool) {
        toolResults.push({ tool: toolId, ok: false, error: "Unknown tool", why });
        continue;
      }

      // Never auto-run tools with any side effects
      if (tool.risk !== ToolRisk.READ_ONLY) {
        toolResults.push({
          tool: toolId,
          ok: false,
          error: `Tool not allowed for auto-run (risk=${tool.risk}).`,
          why,
        });
        continue;
      }

      const ran = await toolRegistry.run({ id: toolId, args, context: { sid } });

      logRunEvent("tool_call", {
        sid,
        tool: toolId,
        ok: ran.ok,
        why,
        args,
        error: ran.ok ? null : ran.error,
      });

      toolResults.push({
        tool: toolId,
        ok: ran.ok,
        why,
        args,
        error: ran.ok ? null : ran.error,
        result: ran.ok ? ran.result : null,
      });
    }

    // Second pass: feed tool results back into planner
    planned = await llmRespondAndPlan({
      message: msg,
      snapshot,
      lastIntent: sessions.get(sid)?.lastIntent || "chat",
      availableTools,
      toolResults,
    });
  }

  const compiled = compilePlanToActions(planned, snapshot);

  const proposed = [];
  for (const a of compiled.actions || []) {
    const saved = addAction(a);
    proposed.push({ id: saved.id, ...a.summary });
  }

  sessions.set(sid, { lastIntent: "change" });
  setLastIntent(sid, "change", msg);

  // Task success if we proposed actions, else neutral
  recordEvent(sid, "task_success", { proposed: proposed.length });

  const affect = getAffectSnapshot(sid);
  const picked = pickEmotion({
    msg,
    affect,
    opinionScore: null,
    disagreeLevel: 0,
    authorityOverride: false,
  });

  console.log("[chat] plan", {
    sid,
    ms: Date.now() - started,
    proposed: proposed.length,
    mood: affect.mood,
    fr: affect.frustration.total,
  });

  const meta = buildSourcesMeta(affect, preToolResults, toolResults, 3);

  return {
    reply: enforcePiper(planned.reply || "Understood, sir."),
    emotion: picked.emotion,
    intensity: picked.intensity,
    proposed,
    meta,
  };
}

export default runPlannerFlow;
