// src/routes/chat/handler.js
import express from "express";
import path from "path";
import os from "os";

import { enforcePiper } from "../../services/persona.js";
import { getAffectSnapshot } from "../../services/mind.js";

import { triageNeedsPlanner } from "../../planner/triage.js";

import runChatFlow from "./workflows/chatFlow.js";
import runPlannerFlow from "./workflows/plannerFlow.js";
import { fileEditFlow } from "./workflows/fileEditFlow.js";
import { proposeAction } from "./workflows/propose.js";

import { maybeFetchWebContext, augmentUserMessageWithWebContext, buildSourcesMeta } from "./workflows/webFlow.js";
import { isWebSearchIntent } from "./parsers/webIntent.js";
import { isListAppsIntent, listAllowlistedAppIds, parseOpenAllowlistedApp } from "./parsers/apps.js";
import {
  parseOpenDesktopFolder,
  parseWriteTextInThere,
  getLastOpenedFolder,
  setLastOpenedFolder,
} from "./parsers/filesystem.js";

import { addAction, updateAction } from "../../actions/store.js";
import { executeAction } from "../../actions/executor.js";

const router = express.Router();

// "Dev Mode" is a routing contract, not just a UI toggle.
// When enabled, Piper must not answer change-requests as chat.
// She should instead route into deterministic dev flows (file edits / code edits)
// and only fall back to planner/inspection as needed.

const CHANGE_VERB = /\b(change|update|set|make|turn|toggle|enable|disable|remove|add|rename|revert|undo|rollback|increase|decrease|move|swap|replace)\b/i;
function looksLikeChangeRequest(message = "") {
  const s = String(message || "");
  // Requests that imply an effect outside conversation.
  return CHANGE_VERB.test(s) || looksLikeUiEdit(s);
}

const INSPECTION_TYPES = new Set(["run_cmd", "read_snippet"]);
function isInspectionOnly(proposed = []) {
  return Array.isArray(proposed) && proposed.length > 0 && proposed.every((a) => INSPECTION_TYPES.has(a?.type));
}

async function autoRunInspectionsAndReplan({ sid, message, req, affect, result }) {
  // Auto-run inspection actions (no approval), then re-enter planner.
  // Capped to prevent infinite loops.
  let loops = 0;
  while (loops < 2 && isInspectionOnly(result?.proposed)) {
    loops++;

    for (const a of result.proposed) {
      if (!a?.id || !INSPECTION_TYPES.has(a.type)) continue;
      if (a.status && a.status !== "pending") continue;

      // Ensure followup metadata exists for snapshot binding.
      a.meta = a.meta || {};
      a.meta.followup = true;
      a.meta.originalMessage = message;
      if (!a.meta.inspectionKind) a.meta.inspectionKind = a.type === "read_snippet" ? "snippet" : "rg";

      updateAction(a.id, { status: "running", updatedAt: Date.now() });
      const execResult = await executeAction(a, { dryRun: false });
      updateAction(a.id, {
        status: execResult?.ok ? "done" : "failed",
        updatedAt: Date.now(),
        result: execResult,
      });
    }

    result = await runPlannerFlow({ sid, message, req });
  }
  return result;
}

// UI/CSS changes are best handled by the deterministic, approval-gated file edit flow.
// This avoids "inspect repo" stalls for common UI edits while keeping approval sacred for changes.
const UI_EDIT_HINT = /\b(css|style|layout|theme|color|background|font|button|panel|sidebar|header|footer|title)\b/i;
function looksLikeUiEdit(message = "") {
  return UI_EDIT_HINT.test(String(message || ""));
}

function newActionId() {
  return (
    "act_" +
    Math.random().toString(16).slice(2) +
    Date.now().toString(16)
  );
}

async function runImmediateAction(action) {
  const id = newActionId();
  const stored = addAction({
    id,
    type: action.type,
    title: action.title,
    reason: action.reason,
    payload: action.payload,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    meta: action.meta || {},
  });

  const result = await executeAction(stored, { dryRun: false });
  const updated = updateAction(id, {
    status: result.ok ? "done" : "failed",
    updatedAt: Date.now(),
    result,
  });

  return { stored: updated || stored, result };
}

router.post("/chat", async (req, res) => {
  const sid = req.body?.sid || req.ip;
  const message = String(req.body?.message || "").trim();
  const affect = getAffectSnapshot?.(sid);
  const devMode = !!req.body?.devMode;

  if (!message) {
    return res.json({
      reply: enforcePiper("Say something for me to act on, sir."),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // =========================
  // NO-APPROVAL FAST PATHS
  // =========================

  // (8) Web search: no approval required, always return sources
  if (isWebSearchIntent(message)) {
    const { preToolResults, webContext } = await maybeFetchWebContext(message, sid);
    const augmented = augmentUserMessageWithWebContext(message, webContext);
    const reply = await runChatFlow({ sid, message: augmented });
    const meta = buildSourcesMeta(affect, preToolResults, [], 3);
    return res.json({
      reply: enforcePiper(reply),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta,
    });
  }

  // (12) List apps: no approval required
  if (isListAppsIntent(message)) {
    const ids = listAllowlistedAppIds();
    const text =
      ids.length > 0
        ? `I can open: ${ids.join(", ")}.`
        : "I don't have any allowlisted apps yet, sir.";
    return res.json({
      reply: enforcePiper(text),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // (9) Open allowlisted app: no approval required
  const openApp = parseOpenAllowlistedApp(message);
  if (openApp) {
    const { result } = await runImmediateAction(openApp);
    const reply = result.ok
      ? `Opening it now, sir.`
      : `I couldn't open that, sir: ${String(result.error || "unknown error")}`;
    return res.json({
      reply: enforcePiper(reply),
      emotion: result.ok ? "neutral" : "serious",
      intensity: result.ok ? 0.35 : 0.55,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // (9/10) Open Desktop folder: no approval required
  const openDesk = parseOpenDesktopFolder(message);
  if (openDesk) {
    const { result } = await runImmediateAction(openDesk);
    if (result.ok && openDesk._folderPath) {
      setLastOpenedFolder(sid, openDesk._folderPath);
    }
    const reply = result.ok
      ? `Opening that folder now, sir.`
      : `I couldn't open that folder, sir: ${String(result.error || "unknown error")}`;
    return res.json({
      reply: enforcePiper(reply),
      emotion: result.ok ? "neutral" : "serious",
      intensity: result.ok ? 0.35 : 0.55,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // (11/14) Create/write a file in the last opened folder: approval REQUIRED
  // Deterministic "in that folder/in there called X" -> propose write_file into known:* path.
  // No repo inspection needed.
  const writeThere = parseWriteTextInThere(message);
  if (writeThere) {
    const lastAbs = getLastOpenedFolder(sid);
    if (!lastAbs) {
      return res.json({
        reply: enforcePiper(
          "Which folder should I use, sir? Open it first (or tell me the path) and I'll create the file there."
        ),
        emotion: "neutral",
        intensity: 0.35,
        proposed: [],
        meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
      });
    }

    // Map the absolute last-opened folder back into a safe "known:" path.
    // We only allow writing inside known Desktop/Downloads/Documents.
    const home = process.env.USERPROFILE || os.homedir();
    const roots = [
      { key: "desktop", abs: path.join(home, "Desktop"), token: "known:desktop" },
      { key: "downloads", abs: path.join(home, "Downloads"), token: "known:downloads" },
      { key: "documents", abs: path.join(home, "Documents"), token: "known:documents" },
    ];

    const lastResolved = path.resolve(String(lastAbs));
    let base = null;
    for (const r of roots) {
      const rootResolved = path.resolve(r.abs);
      if (lastResolved === rootResolved || lastResolved.startsWith(rootResolved + path.sep)) {
        base = { ...r, rootResolved };
        break;
      }
    }

    if (!base) {
      return res.json({
        reply: enforcePiper(
          "For safety, I can only create files inside Desktop, Downloads, or Documents, sir. Open a folder in one of those and try again."
        ),
        emotion: "serious",
        intensity: 0.55,
        proposed: [],
        meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
      });
    }

    const relFolder = path.relative(base.rootResolved, lastResolved);
    const relParts = relFolder ? relFolder.split(path.sep).filter(Boolean) : [];
    const relKnown = [base.token, ...relParts, writeThere.filename].join("/");

    const action = proposeAction({
      type: "write_file",
      title: `Create file: ${writeThere.filename}`,
      reason: `User requested creating a file in the last opened folder (${base.key}). Approval required for writes.`,
      payload: {
        path: relKnown,
        content: "", // create empty file by default
      },
    });

    return res.json({
      reply: enforcePiper(
        `I can create that file for you, sir. Please approve the write action.`
      ),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [action],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // =========================
  // CHAT vs PLAN
  // =========================

  let triage = await triageNeedsPlanner({
    message,
    lastIntent: req.body?.lastIntent,
  });

  // DEV MODE CONTRACT:
  // In Dev Mode, treat change-requests as PLAN even if triage thinks they are chat.
  // This prevents "I did it" replies without actions.
  if (devMode && triage?.mode === "chat" && looksLikeChangeRequest(message)) {
    triage = { ...triage, mode: "plan", reason: "devMode_change_request" };
  }

  if (triage.mode === "chat") {
    const reply = await runChatFlow({ sid, message });
    return res.json({
      reply: enforcePiper(reply),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // Prefer deterministic, approval-gated file edits for UI/CSS tweaks.
  // In Dev Mode, try the editor first for ANY change-request, then fall back.
  if (devMode || looksLikeUiEdit(message)) {
    try {
      const out = await fileEditFlow({ sid, message });
      if (Array.isArray(out?.proposed) && out.proposed.length > 0) {
        return res.json(out);
      }
    } catch {
      // If fileEditFlow fails, proceed to planner.
    }
  }

  // 🔒 PLAN MODE — MUST PRODUCE ACTIONS (approval-gated for writes/patches)
  let result = await runPlannerFlow({ sid, message, req });

  // 🔒 Intent Contract Invariant (non-negotiable)
  if (!Array.isArray(result?.proposed) || result.proposed.length === 0) {
    result = await runPlannerFlow({ sid, message, req, forceInspection: true });
  }

  // If planner proposes only inspections, auto-run them (no approval) and replan.
  result = await autoRunInspectionsAndReplan({ sid, message, req, affect, result });

  // Final guard: never allow plan->empty-proposed escape hatch.
  if (!Array.isArray(result?.proposed) || result.proposed.length === 0) {
    const fallback = proposeAction({
      type: "run_cmd",
      title: "Inspect repo (fallback)",
      reason:
        "Invariant recovery: planner returned no actions. Running an inspection to ground the request.",
      payload: {
        cmd: `rg -n "${message
          .replace(/[^a-zA-Z0-9_\s-]/g, " ")
          .trim()
          .slice(0, 60) || "piper"}" src public`,
        timeoutMs: 12000,
      },
    });
    fallback.meta = {
      followup: true,
      originalMessage: message,
      inspectionKind: "rg",
    };

    // Auto-run the fallback inspection (no approval) and replan once.
    // This avoids stalling the user on safe, read-only grounding.
    try {
      // Persist as a real action so UI can show it in Recent Actions.
      // proposeAction already stored it with an id.
      updateAction(fallback.id, { status: "running", updatedAt: Date.now() });
      const execResult = await executeAction(fallback, { dryRun: false });
      updateAction(fallback.id, {
        status: execResult?.ok ? "done" : "failed",
        updatedAt: Date.now(),
        result: execResult,
      });
      result = await runPlannerFlow({ sid, message, req });
    } catch {
      // If anything goes wrong, fall back to returning the inspection action.
      return res.json({
        reply: enforcePiper(
          "I need to inspect the repo before I can act safely. Please approve the inspection action, sir."
        ),
        emotion: "serious",
        intensity: 0.55,
        proposed: [fallback],
        meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
      });
    }
  }

  return res.json(result);
});

export default router;
export const chatHandler = router;
