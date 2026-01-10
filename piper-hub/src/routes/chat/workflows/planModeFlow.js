// src/routes/chat/workflows/planModeFlow.js
// Phase 4 Plan Mode workflow: create/approve/abort plans without executing actions.
// Keeps "approval is sacred" by only drafting plans and changing plan status.

import { EMPTY_SOURCES } from "../constants.js";
import { getCurrentPlan, upsertPlan, setPlanStatus } from "../../../services/plan/store.js";

function norm(s) {
  return String(s || "").trim();
}

export function isAbortPlanCommand(msg) {
  const s = norm(msg).toLowerCase();
  return (
    s === "abort plan" ||
    s === "cancel plan" ||
    s === "stop plan" ||
    s === "abort" ||
    s === "cancel"
  );
}

export function isApprovePlanCommand(msg) {
  const s = norm(msg).toLowerCase();
  return (
    s === "approve plan" ||
    s === "proceed plan" ||
    s === "continue plan"
  );
}

export function looksLikeHighLevelProject(msg) {
  const s = norm(msg).toLowerCase();
  if (!s) return false;
  // Conservative: only trigger plan mode for "setup / integrate / build / automate" type requests.
  if (/\b(let'?s|lets)\b/.test(s) && /(set\s*up|integrat|build|automate|wire\s*up|connect)/.test(s)) return true;
  if (/(set\s*up|integrat|build|automate|wire\s*up|connect)\b/.test(s)) return true;
  return false;
}

function draftGenericIntegrationPlan({ sid, goal }) {
  const now = Date.now();
  return {
    planId: `plan_${sid}_${now}`,
    goal,
    status: "proposed",
    createdAt: now,
    updatedAt: now,
    risks: [
      "Requires secrets/tokens (must be provided by you)",
      "Network permissions and scopes may be required",
      "File writes are approval-gated",
    ],
    steps: [
      { title: "Inspect current hub integration points", type: "inspect", approvalRequired: false },
      { title: "Gather requirements and minimal permissions", type: "research", approvalRequired: false },
      { title: "Create capability folder", type: "write_file", approvalRequired: true },
      { title: "Add capability README", type: "write_file", approvalRequired: true },
      { title: "Add capability entrypoint", type: "write_file", approvalRequired: true },
      { title: "Add routes placeholder", type: "write_file", approvalRequired: true },
      { title: "Add executors placeholder", type: "write_file", approvalRequired: true },
      { title: "Add self-check placeholder", type: "write_file", approvalRequired: true },
    ],
  };
}

/**
 * @param {object} ctx
 * @param {string} ctx.sid
 * @param {string} ctx.msg
 * @param {object} ctx.reqBody
 * @param {function} ctx.enforcePiper
 * @param {function} ctx.getAffectSnapshot
 * @param {function} ctx.pushConversationTurn
 * @returns {null|object} response JSON to return from /chat
 */
export function maybeHandlePlanMode(ctx) {
  const { sid, msg, reqBody, enforcePiper, getAffectSnapshot, pushConversationTurn } = ctx;
  const affect = getAffectSnapshot(sid);

  // Abort
  if (isAbortPlanCommand(msg)) {
    const plan = setPlanStatus(sid, "aborted");
    const reply = enforcePiper(plan ? "Plan aborted, sir." : "No active plan to abort, sir.");
    pushConversationTurn(sid, "assistant", reply);
    return { reply, emotion: "neutral", intensity: 0.4, proposed: [], meta: { affect, plan, sources: EMPTY_SOURCES } };
  }

  // Approve (marks approved; actual execution still handled elsewhere)
  if (isApprovePlanCommand(msg)) {
    const plan = setPlanStatus(sid, "approved");
    const reply = enforcePiper(plan ? "Plan approved, sir. Ready for the next step." : "No active plan to approve, sir.");
    pushConversationTurn(sid, "assistant", reply);
    return { reply, emotion: "confident", intensity: 0.45, proposed: [], meta: { affect, plan, sources: EMPTY_SOURCES } };
  }

  // Create a plan draft if the message looks like a project and there isn't an active plan already.
  const current = getCurrentPlan(sid);
  const hasActive = current && (current.status === "proposed" || current.status === "approved" || current.status === "executing");
  const wantsPlan = looksLikeHighLevelProject(msg);

  if (wantsPlan && !hasActive) {
    const goal = norm(msg);
    const plan = draftGenericIntegrationPlan({ sid, goal });
    upsertPlan(sid, plan);

    const reply = enforcePiper("Understood, sir. I’ve drafted a plan — approve it when you’re ready.");
    pushConversationTurn(sid, "assistant", reply);

    return { reply, emotion: "confident", intensity: 0.45, proposed: [], meta: { affect, plan, sources: EMPTY_SOURCES } };
  }

  return null;
}
