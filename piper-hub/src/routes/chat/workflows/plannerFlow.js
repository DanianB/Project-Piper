// src/routes/chat/workflows/plannerFlow.js
// Planner workflow (Intent -> Inspect -> Propose)
//
// This is the ONLY place we should turn a "plan" intent into approval items.
//
// Non-negotiable invariants for plan-intent responses:
// 1) `proposed` MUST contain at least one queued action.
// 2) If a deterministic patch isn't possible yet, propose inspection (still approval-gated).

import { llmRespondAndPlan } from "../../../planner/planner.js";
import { buildSnapshot } from "../../../planner/snapshot.js";
import { compilePlanToActions } from "../../../planner/compiler.js";
import { proposeAction } from "./propose.js";
import { enforcePiper } from "../../../services/persona.js";
import { getAffectSnapshot, recordEvent } from "../../../services/mind.js";

function safeRgQueryFromMessage(message) {
  const STOP = new Set([
    "a","an","and","are","as","at","be","but","by","can","could","did","do","does","for","from",
    "give","help","hello","hey","hi","how","i","in","is","it","me","my","of","ok","on","or","our",
    "please","pls","search","set","sir","tell","that","the","their","then","this","to","update","you","your",
    "change","modify","make","add","remove","fix","edit","open","create","write","find","look","up","web","internet"
  ]);

  const words = String(message || "")
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/g)
    .filter(Boolean)
    .filter((w) => w.length >= 2 && w.length <= 32)
    .filter((w) => !STOP.has(w));

  // Keep it small + stable
  const unique = [];
  const seen = new Set();
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    unique.push(w);
    if (unique.length >= 6) break;
  }

  if (unique.length === 0) {
    // If the user asked about the page title specifically, bias toward HTML title tags.
    if (/\btitle\b/i.test(String(message || ""))) return "<title|document.title|title:";
    return "piper";
  }
  // rg supports alternation; we keep it alnum/underscore only from above.
  return unique.join("|");
}

/**
 * @param {object} input
 * @param {string} input.sid
 * @param {string} input.message
 * @param {object} [input.req]
 * @param {boolean} [input.forceInspection]
 */
export async function runPlannerFlow(input = {}) {
  const sid = input.sid || "default";
  const message = String(input.message || "");
  const started = Date.now();

  // Always build a fresh snapshot for this request.
  const snapshot = await buildSnapshot({ message, lastIntent: "plan" });

  // Ask the planner.
  let plan = await llmRespondAndPlan({
    message,
    snapshot,
    availableTools: Array.isArray(input.availableTools)
      ? input.availableTools
      : [],
    toolResults: Array.isArray(input.toolResults) ? input.toolResults : null,
  });

  // Handler triage already decided this is a "plan" request.
  // Make that explicit so the compiler can safely queue grounding inspections.
  if (!plan || typeof plan !== "object") plan = { reply: "Understood, sir.", ops: [] };
  plan.requiresApproval = true;

  // If the caller explicitly forces inspection (e.g. invariant retry), erase ops.
  if (input.forceInspection === true) {
    plan.ops = [];
    plan.reply =
      typeof plan.reply === "string" && plan.reply.trim()
        ? plan.reply
        : "I need to inspect first, sir.";
  }

  const compiled = compilePlanToActions({ snapshot, plan });
  const actions = Array.isArray(compiled?.actions) ? compiled.actions : [];

  // Queue actions into the action store and return those queued objects.
  const proposed = [];
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const queued = proposeAction({
      type: a.type,
      title: a.title,
      reason: a.reason,
      payload: a.payload,
    });

    // Preserve meta if present (store doesn't require it, but snapshot/looping does).
    if (a.meta && typeof a.meta === "object") {
      queued.meta = { ...a.meta };
    }

    proposed.push(queued);
  }

  // Absolute last-resort: NEVER return empty proposed for plan.
  if (proposed.length === 0) {
    const q = safeRgQueryFromMessage(message);
    const fallback = proposeAction({
      type: "run_cmd",
      title: "Inspect repo for relevant code/UI references",
      reason:
        "Planner could not produce a deterministic action yet. Inspection is required to ground the change.",
      payload: {
        cmd: `rg -n "${q}" src public`,
        timeoutMs: 12000,
      },
    });
    fallback.meta = {
      followup: true,
      originalMessage: message,
      inspectionKind: "rg",
    };
    proposed.push(fallback);
  }

  recordEvent?.(sid, "planner_complete", {
    ms: Date.now() - started,
    proposed: proposed.length,
  });

  return {
    reply: enforcePiper(
      String(compiled?.reply || plan?.reply || "Ready for approval, sir.")
    ),
    emotion: plan?.emotion || "neutral",
    intensity: typeof plan?.intensity === "number" ? plan.intensity : 0.4,
    proposed,
    meta: {
      affect: getAffectSnapshot?.(sid),
      sources: Array.isArray(plan?.sources)
        ? { total: plan.sources.length, shown: plan.sources, hidden: [] }
        : { total: 0, shown: [], hidden: [] },
      stage: compiled?.stage || plan?.stage || {},
    },
  };
}

export default runPlannerFlow;
