// src/routes/chat/workflows/plannerFlow.js
import { llmRespondAndPlan } from "../../../planner/planner.js";
import { enforcePiper } from "../../../services/persona.js";
import { getAffectSnapshot, recordEvent } from "../../../services/mind.js";

/**
 * CRITICAL INVARIANT:
 * If planner is entered, it MUST return proposed actions.
 * If it cannot → it MUST propose inspection.
 */
export async function runPlannerFlow(input = {}) {
  const sid = input.sid || "default";
  const message = String(input.message || "");
  const started = Date.now();

  let planned;
  try {
    planned = await llmRespondAndPlan({
      message,
      snapshot: input.snapshot || {},
      availableTools: Array.isArray(input.availableTools)
        ? input.availableTools
        : [],
      toolResults: Array.isArray(input.toolResults) ? input.toolResults : [],
      forceInspection: false,
    });
  } catch (err) {
    throw err;
  }

  let proposed =
    Array.isArray(planned?.ops) && planned.ops.length
      ? planned.ops
      : Array.isArray(planned?.proposed)
      ? planned.proposed
      : [];

  // 🚨 INVARIANT ENFORCEMENT
  if (proposed.length === 0) {
    // Force inspection proposal
    proposed = [
      {
        type: "inspect_repo",
        title: "Inspect repository for relevant UI/code changes",
        reason:
          "Planner could not determine exact files/selectors. Inspection required.",
        payload: {
          query: message,
        },
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
  }

  recordEvent?.(sid, "planner_complete", {
    ms: Date.now() - started,
    proposed: proposed.length,
  });

  return {
    reply: enforcePiper(
      planned?.reply ||
        "I’ve identified what needs to be done. Please review the proposed action."
    ),
    emotion: planned?.emotion || "neutral",
    intensity: typeof planned?.intensity === "number" ? planned.intensity : 0.4,
    proposed,
    meta: {
      affect: getAffectSnapshot?.(sid),
      sources: planned?.sources || { total: 0, shown: [], hidden: [] },
    },
  };
}

export default runPlannerFlow;
