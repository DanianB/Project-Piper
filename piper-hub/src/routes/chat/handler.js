// src/routes/chat/handler.js
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";

import { enforcePiper } from "../../services/persona.js";
import { getAffectSnapshot } from "../../services/mind.js";

import { triageNeedsPlanner } from "../../planner/triage.js";

import runChatFlow from "./workflows/chatFlow.js";
import runPlannerFlow from "./workflows/plannerFlow.js";
import { fileEditFlow } from "./workflows/fileEditFlow.js";
import { proposeAction } from "./workflows/propose.js";

import {
  maybeFetchWebContext,
  augmentUserMessageWithWebContext,
  buildSourcesMeta,
} from "./workflows/webFlow.js";
import { isWebSearchIntent } from "./parsers/webIntent.js";
import {
  isListAppsIntent,
  listAllowlistedAppIds,
  parseOpenAllowlistedApp,
} from "./parsers/apps.js";
import {
  parseOpenDesktopFolder,
  parseWriteTextInThere,
  getLastOpenedFolder,
  setLastOpenedFolder,
} from "./parsers/filesystem.js";

import { addAction, updateAction, listActions } from "../../actions/store.js";
import { executeAction } from "../../actions/executor.js";

const router = express.Router();

// -------------------------
// Undo / rollback intent
// -------------------------

const UNDO_RE = /\b(undo|revert|rollback|roll\s*back|change\s+it\s+back|put\s+it\s+back)\b/i;
const UNDO_COUNT_RE = /\b(?:last|previous)\s+(\d+)\b|\b(\d+)\s+(?:changes|edits|things)\b/i;
const WORD_NUM = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseUndoCount(msg) {
  const s = String(msg || "").toLowerCase();
  const m = s.match(UNDO_COUNT_RE);
  if (m) {
    const n = Number(m[1] || m[2]);
    if (Number.isFinite(n) && n > 0) return Math.min(10, Math.trunc(n));
  }
  // word numbers: "last two changes"
  const w = s.match(/\b(?:last|previous)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (w) return WORD_NUM[w[1]] || 1;
  return 1;
}

function isUndoIntent(msg) {
  return UNDO_RE.test(String(msg || ""));
}

function isRollbackableAction(a) {
  if (!a || typeof a !== "object") return false;
  if (a.status !== "done") return false;
  if (!["apply_patch", "write_file"].includes(String(a.type || ""))) return false;
  const info = a?.result?.result || {};
  return Boolean(info.path && info.backup);
}

function buildRollbackSteps(count) {
  const all = (listActions() || []).filter(isRollbackableAction);
  const chosen = all.slice(0, Math.max(1, count));
  return chosen.map((a) =>
    proposeAction({
      type: "rollback",
      title: `Rollback: ${a.type} (${String((a.result?.result || {}).path || "file")})`,
      reason: "User requested an undo/revert of recent approved changes.",
      payload: { id: a.id },
      meta: { rollbackTargetId: a.id },
    })
  );
}

// UI/CSS changes are best handled by the deterministic, approval-gated file edit flow.
// This avoids "inspect repo" stalls for common UI edits while keeping approval sacred for changes.
const UI_EDIT_HINT =
  /\b(css|style|layout|theme|color|background|font|button|panel|sidebar|header|footer|title)\b/i;
function looksLikeUiEdit(message = "") {
  return UI_EDIT_HINT.test(String(message || ""));
}

// Broad "development" requests that should be handled in Dev Mode (codebase inspection + approval-gated changes).
// This is intentionally coarse (not feature/keyword-specific), and only gates when the user clearly asks for
// code/integration work rather than everyday operations.
const DEV_WORK_HINT =
  /\b(code|repo|repository|refactor|patch|commit|diff|css|ui|frontend|backend|server|route|endpoint|api|integrat(e|ion)|mcp|bug|fix)\b/i;

// Inspections (repo search / snippet reads) should NOT be approval-gated.
// They should run immediately, then we re-enter the planner with the new grounding.
const INSPECTION_TYPES = new Set(["run_cmd", "read_snippet"]);

function isInspectionOnly(proposed = []) {
  return (
    Array.isArray(proposed) &&
    proposed.length > 0 &&
    proposed.every((a) => INSPECTION_TYPES.has(a?.type))
  );
}

async function runQueuedInspection(action, originalMessage) {
  if (!action?.id) return;

  // Ensure followup metadata exists so downstream flows can bind results.
  action.meta = action.meta && typeof action.meta === "object" ? action.meta : {};
  action.meta.followup = true;
  action.meta.originalMessage = originalMessage;

  updateAction(action.id, { status: "running", updatedAt: Date.now() });
  const execResult = await executeAction(action, { dryRun: false });
  updateAction(action.id, {
    status: execResult?.ok ? "done" : "failed",
    updatedAt: Date.now(),
    result: execResult,
  });
}

function canDeterministicallyStyleOffButton(message = "") {
  const m = String(message || "").toLowerCase();
  if (!m.includes("button")) return false;
  if (!m.includes("off")) return false;
  if (!/\b(background|bg|colour|color)\b/.test(m)) return false;
  if (!/\bblack\b/.test(m) && !/#000000\b|#000\b/.test(m)) return false;
  return true;
}

function repoHasOffButtonId() {
  try {
    const html = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
    return /id\s*=\s*"off"/i.test(html);
  } catch {
    return false;
  }
}

function newActionId() {
  return "act_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
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
    const { preToolResults, webContext } = await maybeFetchWebContext(
      message,
      sid
    );
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

  // (12) List apps: no approval required (disabled in Dev Mode)
  if (devMode && isListAppsIntent(message)) {
    return res.json({
      reply: enforcePiper(
        "Dev Mode is active, sir. Operational commands like listing or opening apps are paused so I can focus on code work. Say 'Deactivate Dev Mode' to resume normal operations."
      ),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }
  if (!devMode && isListAppsIntent(message)) {
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

  // (9) Open allowlisted app: no approval required (paused in Dev Mode)
  const openApp = parseOpenAllowlistedApp(message);
  if (devMode && openApp) {
    return res.json({
      reply: enforcePiper(
        "Dev Mode is active, sir. I won't open apps while I'm focused on code changes. Say 'Deactivate Dev Mode' to resume normal operations."
      ),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }
  if (!devMode && openApp) {
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

  // (9/10) Open Desktop folder: no approval required (paused in Dev Mode)
  const openDesk = parseOpenDesktopFolder(message);
  if (devMode && openDesk) {
    return res.json({
      reply: enforcePiper(
        "Dev Mode is active, sir. I won't open folders or browse files while I'm focused on code changes. Say 'Deactivate Dev Mode' to resume normal operations."
      ),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }
  if (!devMode && openDesk) {
    const { result } = await runImmediateAction(openDesk);
    if (result.ok && openDesk._folderPath) {
      setLastOpenedFolder(sid, openDesk._folderPath);
    }
    const reply = result.ok
      ? `Opening that folder now, sir.`
      : `I couldn't open that folder, sir: ${String(
          result.error || "unknown error"
        )}`;
    return res.json({
      reply: enforcePiper(reply),
      emotion: result.ok ? "neutral" : "serious",
      intensity: result.ok ? 0.35 : 0.55,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // (11/14) Create/write a file in the last opened folder: approval REQUIRED (disabled in Dev Mode)
  // Deterministic "in that folder/in there called X" -> propose write_file into known:* path.
  // No repo inspection needed.
  const writeThere = parseWriteTextInThere(message);
  if (devMode && writeThere) {
    return res.json({
      reply: enforcePiper(
        "Dev Mode is active, sir. I won't create or write files outside the codebase while I'm focused on code changes. Say 'Deactivate Dev Mode' to resume normal operations."
      ),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }
  if (!devMode && writeThere) {
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
      {
        key: "desktop",
        abs: path.join(home, "Desktop"),
        token: "known:desktop",
      },
      {
        key: "downloads",
        abs: path.join(home, "Downloads"),
        token: "known:downloads",
      },
      {
        key: "documents",
        abs: path.join(home, "Documents"),
        token: "known:documents",
      },
    ];

    const lastResolved = path.resolve(String(lastAbs));
    let base = null;
    for (const r of roots) {
      const rootResolved = path.resolve(r.abs);
      if (
        lastResolved === rootResolved ||
        lastResolved.startsWith(rootResolved + path.sep)
      ) {
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
  // UNDO / ROLLBACK (approval-gated)
  // =========================
  // Conversational rollback of the most recent approved codebase changes.
  // Supports multi-step: "undo the last 2 changes", "revert last three", etc.
  if (isUndoIntent(message)) {
    const n = parseUndoCount(message);
    const steps = buildRollbackSteps(n);

    if (!steps.length) {
      return res.json({
        reply: enforcePiper(
          "I don't have any recent approved changes I can roll back yet, sir."
        ),
        emotion: "neutral",
        intensity: 0.35,
        proposed: [],
        meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
      });
    }

    if (steps.length === 1) {
      return res.json({
        reply: enforcePiper(
          "Understood, sir. I can roll back the most recent change — please approve."
        ),
        emotion: "neutral",
        intensity: 0.35,
        proposed: [steps[0]],
        meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
      });
    }

    const bundle = proposeAction({
      type: "bundle",
      title: `Rollback last ${steps.length} changes`,
      reason: "User requested rolling back multiple recent approved changes.",
      payload: {
        actions: steps.map((s) => ({
          type: "rollback",
          title: s.title,
          reason: s.reason,
          payload: s.payload,
          meta: s.meta || {},
        })),
      },
    });

    return res.json({
      reply: enforcePiper(
        `Understood, sir. I can roll back the last ${steps.length} changes — please approve.`
      ),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [bundle],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // =========================
  // CHAT vs PLAN
  // =========================

  const triage = await triageNeedsPlanner({
    message,
    lastIntent: req.body?.lastIntent,
  });

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

  // Dev Mode is where Piper performs codebase work (inspection + approval-gated changes).
  // Out of Dev Mode, we still allow normal operations (open apps/folders, create files, chat, small web searches),
  // but we avoid mixing in code-edit planning unless Dev Mode is enabled.
  if (!devMode && (looksLikeUiEdit(message) || DEV_WORK_HINT.test(message))) {
    return res.json({
      reply: enforcePiper(
        "That sounds like development work, sir. Please say 'Activate Dev Mode' (or tick Dev Mode) and repeat the request so I stay focused on code changes and approvals."
      ),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // =========================
  // DEV MODE: deterministic code edits first
  // =========================

  // Known, grounded UI control: Off button is id="off" in public/index.html.
  // If the user explicitly requests a black background, propose an approval-gated CSS patch directly.
  if (devMode && canDeterministicallyStyleOffButton(message) && repoHasOffButtonId()) {
    const cssAppend =
      `\n\n/* Piper dev edit (approval-gated): Off button background */\n#off {\n  background: black !important;\n}\n`;

    const action = proposeAction({
      type: "apply_patch",
      title: "Set Off button background to black",
      reason: "User requested a UI style change. Approval required for code edits.",
      payload: {
        path: "public/styles.css",
        edits: [{ find: "", replace: cssAppend, mode: "append" }],
      },
    });

    return res.json({
      reply: enforcePiper("Understood, sir. I can make that change — please approve the patch."),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [action],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // In Dev Mode, try the deterministic file edit flow BEFORE planner/inspection.
  if (devMode && looksLikeUiEdit(message)) {
    try {
      const out = await fileEditFlow({ sid, message });
      if (Array.isArray(out?.proposed) && out.proposed.length > 0) return res.json(out);
    } catch {
      // fall through
    }
  }

  // Outside Dev Mode, we still allow deterministic UI edits only if not gated above.
  if (!devMode && looksLikeUiEdit(message)) {
    try {
      const out = await fileEditFlow({ sid, message });
      if (Array.isArray(out?.proposed) && out.proposed.length > 0) return res.json(out);
    } catch {
      // fall through
    }
  }

  // =========================
  // PLAN MODE — MUST PRODUCE ACTIONS
  // =========================
  let result = await runPlannerFlow({ sid, message, req });

  // 🔒 Intent Contract Invariant (non-negotiable)
  if (!Array.isArray(result?.proposed) || result.proposed.length === 0) {
    result = await runPlannerFlow({ sid, message, req, forceInspection: true });
  }

  // Auto-run inspection-only actions (no approval) and then re-plan.
  // This prevents "Approve" being required for repo searches/snippets.
  for (let i = 0; i < 2; i++) {
    if (!isInspectionOnly(result?.proposed)) break;
    for (const a of result.proposed) {
      await runQueuedInspection(a, message);
    }
    result = await runPlannerFlow({ sid, message, req });
  }

  // Final guard: if planner still produced nothing, do one immediate inspection and re-plan.
  if (!Array.isArray(result?.proposed) || result.proposed.length === 0) {
    const fallback = proposeAction({
      type: "run_cmd",
      title: "Inspect repo (auto)",
      reason: "Planner returned no actions; auto-inspecting to ground the request.",
      payload: {
        cmd: `rg -n "${
          message.replace(/[^a-zA-Z0-9_\s-]/g, " ").trim().slice(0, 60) || "piper"
        }" src public`,
        timeoutMs: 12000,
      },
    });

    await runQueuedInspection(fallback, message);
    result = await runPlannerFlow({ sid, message, req });
  }

  return res.json(result);
});

export default router;
export const chatHandler = router;
