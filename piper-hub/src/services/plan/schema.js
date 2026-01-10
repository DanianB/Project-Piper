// src/services/plan/schema.js
// Very small schema/normalizer for Phase 4 Plan Mode.
// Keeps the contract stable without adding heavy deps.

export function normalizePlanDraft(draft = {}) {
  const now = new Date().toISOString();
  const plan = {
    planId: String(draft.planId || "").trim() || `plan_${Math.random().toString(16).slice(2)}_${Date.now()}`,
    sid: String(draft.sid || "").trim(),
    goal: String(draft.goal || "").trim() || "Untitled plan",
    status: String(draft.status || "proposed"),
    createdAt: draft.createdAt || now,
    updatedAt: now,
    risks: Array.isArray(draft.risks) ? draft.risks.map(String) : [],
    steps: Array.isArray(draft.steps) ? draft.steps.map(s => ({
      stepId: String(s.stepId || "").trim() || `step_${Math.random().toString(16).slice(2)}_${Date.now()}`,
      type: String(s.type || "inspect"),
      title: String(s.title || s.goal || "").trim() || "Step",
      approvalRequired: Boolean(s.approvalRequired),
      notes: String(s.notes || ""),
    })) : [],
  };
  return plan;
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== "object") return { ok: false, error: "Plan missing" };
  if (!plan.planId) return { ok: false, error: "planId missing" };
  if (!plan.sid) return { ok: false, error: "sid missing" };
  if (!plan.goal) return { ok: false, error: "goal missing" };
  if (!Array.isArray(plan.steps)) return { ok: false, error: "steps must be array" };
  return { ok: true };
}
