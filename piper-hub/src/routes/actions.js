import { Router } from "express";
import fs from "fs";

import { OFF_EXIT_CODE } from "../config/constants.js";
import { OFF_FLAG_PATH } from "../config/paths.js";

import {
  addAction,
  listActions,
  updateAction,
  getActionById,
} from "../actions/store.js";

import { executeAction, restoreBackup } from "../actions/executor.js";
import { logRunEvent } from "../utils/runlog.js";

import {
  isPreviewableType,
  computePreviewFilesForAction,
  htmlPreviewPage,
} from "../actions/preview.js";

// 🔁 SMART LOOP imports
import { buildSnapshot } from "../planner/snapshot.js";
import { llmRespondAndPlan } from "../planner/planner.js";
import { compilePlanToActions } from "../planner/compiler.js";

export function actionRoutes() {
  const r = Router();

  /* =========================
   * LIST ACTIONS
   * ========================= */
  r.get("/actions", (req, res) =>
    res.json({ ok: true, actions: listActions() })
  );

  /* =========================
   * PREVIEW (JSON)
   * ========================= */
  r.get("/action/preview/:id.json", (req, res) => {
    try {
      const action = getActionById(String(req.params.id || ""));
      if (!action)
        return res.status(404).json({ ok: false, error: "Unknown action id" });

      if (!isPreviewableType(action.type))
        return res.json({ ok: true, action, files: [] });

      const files = computePreviewFilesForAction(action);
      res.json({ ok: true, action, files });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  /* =========================
   * PREVIEW (HTML)
   * ========================= */
  r.get("/action/preview/:id", (req, res) => {
    try {
      const action = getActionById(String(req.params.id || ""));
      if (!action) return res.status(404).send("Unknown action id");

      if (!isPreviewableType(action.type)) {
        return res.status(200).send(
          `<!doctype html>
<meta charset="utf-8">
<title>No preview</title>
<body style="font-family:system-ui;padding:16px">
No preview available for <b>${String(action.type)}</b>.
<a href="/">Back</a>
</body>`
        );
      }

      const files = computePreviewFilesForAction(action);
      res.status(200).send(htmlPreviewPage({ action, files }));
    } catch (e) {
      res.status(500).send("Preview error: " + String(e));
    }
  });

  /* =========================
   * REJECT
   * ========================= */
  r.post("/action/reject", (req, res) => {
    const { id, note } = req.body || {};
    logRunEvent({ kind: "action_reject", id, note: note ? String(note).slice(0,200) : "" });

    const a = updateAction(id, {
      status: "rejected",
      updatedAt: Date.now(),
      note: note ? String(note) : "",
    });

    if (!a)
      return res.status(404).json({ ok: false, error: "Unknown action id" });

    res.json({ ok: true, action: a });
  });

  /* =========================
   * ROLLBACK
   * ========================= */
  r.post("/action/rollback", (req, res) => {
    logRunEvent({ kind: "action_rollback", id: (req.body||{}).id, dryRun: Boolean((req.body||{}).dryRun) });
    const { id, dryRun } = req.body || {};
    const a = getActionById(id);
    if (!a)
      return res.status(404).json({ ok: false, error: "Unknown action id" });

    try {
      const info = a.result?.result || {};
      const target = info.path;
      const backup = info.backup;

      if (!target || !backup)
        return res
          .status(400)
          .json({ ok: false, error: "No rollback info available." });

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, wouldRestore: { target, backup } });
      }

      restoreBackup(backup, target);

      const u = updateAction(id, {
        status: "rolled_back",
        updatedAt: Date.now(),
        rollback: { ok: true, restoredFrom: backup },
      });

      res.json({ ok: true, action: u });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  /* =========================
   * APPROVE (EXECUTE + SMART LOOP)
   * ========================= */
  r.post("/action/approve", async (req, res) => {
    const { id, dryRun } = req.body || {};
    const a = getActionById(id);

    if (!a)
      return res.status(404).json({ ok: false, error: "Unknown action id" });

    if (a.status !== "pending")
      return res.json({ ok: true, action: a, message: "Already processed" });

    updateAction(id, { status: "running", updatedAt: Date.now() });

    console.log(`[executor] execute type="${a.type}" id="${a.id}"`);

    logRunEvent({ kind: "action_approve", id: a.id, type: a.type, dryRun: Boolean(dryRun) });

    const result = await executeAction(a, { dryRun: Boolean(dryRun) });

    const updated = updateAction(id, {
      result,
      updatedAt: Date.now(),
      status: result.ok ? "done" : "failed",
    });

    res.json({ ok: true, action: updated });

    /* =========================
     * 🔁 SMART LOOP
     * ========================= */
    if (
      updated.status === "done" &&
      updated.type === "run_cmd" &&
      updated.meta?.followup &&
      typeof updated.meta.originalMessage === "string"
    ) {
      try {
        console.log(
          `[loop] inspection complete → replanning for: "${updated.meta.originalMessage}"`
        );

        const snapshot = await buildSnapshot({
          message: updated.meta.originalMessage,
          lastIntent: "plan",
        });

        const plan = await llmRespondAndPlan({
          message: updated.meta.originalMessage,
          snapshot,
        });

        const compiled = compilePlanToActions({
          plan,
          snapshot,
          readOnly: false,
        });

        if (compiled.actions?.length) {
          console.log(
            `[loop] queued ${compiled.actions.length} follow-up action(s)`
          );
        }

        for (const a2 of compiled.actions || []) {
          addAction({
            id:
              "act_" +
              Math.random().toString(16).slice(2) +
              Date.now().toString(16),
            ...a2,
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            result: null,
          });
        }
      } catch (e) {
        console.error("[loop] follow-up planning failed:", e);
      }
    }

    /* =========================
     * RESTART / OFF HANDLING
     * ========================= */
    const wantsRestart =
      (updated.type === "restart_piper" && updated.status === "done") ||
      (updated.type === "bundle" &&
        updated.status === "done" &&
        updated.result?.result?.restartRequested);

    const wantsOff =
      (updated.type === "shutdown_piper" && updated.status === "done") ||
      (updated.type === "bundle" &&
        updated.status === "done" &&
        updated.result?.result?.offRequested);

    if (wantsRestart) {
      setTimeout(() => process.exit(0), 250).unref();
      return;
    }

    if (wantsOff) {
      setTimeout(() => {
        try {
          fs.writeFileSync(
            OFF_FLAG_PATH,
            `OFF ${new Date().toISOString()}\n`,
            "utf8"
          );
        } catch {}
        process.exit(OFF_EXIT_CODE);
      }, 250).unref();
    }
  });

  /* =========================
   * MANUAL ADD (used by compiler / tooling)
   * ========================= */
  r.post("/action/add", (req, res) => {
    const { type, title, reason, payload } = req.body || {};
    const id =
      "act_" + Math.random().toString(16).slice(2) + Date.now().toString(16);

    const a = addAction({
      id,
      type: String(type),
      title: String(title || type),
      reason: String(reason || ""),
      payload: payload && typeof payload === "object" ? payload : {},
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: null,
    });

    res.json({ ok: true, action: a });
  });

  return r;
}
