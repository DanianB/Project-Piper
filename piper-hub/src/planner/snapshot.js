// src/planner/snapshot.js
import fs from "fs";
import path from "path";
import { listActions } from "../actions/store.js";

function safeRead(relPath, maxBytes = 200_000) {
  try {
    const abs = path.resolve(relPath);
    if (!fs.existsSync(abs)) return null;
    const buf = fs.readFileSync(abs);
    if (!buf) return null;
    return buf.slice(0, maxBytes).toString("utf8");
  } catch {
    return null;
  }
}

function normalizeMsg(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[.?!]+$/g, "") // drop trailing punctuation
    .replace(/\s+/g, " "); // normalize spaces
}

function detectInspectionKindFromCmd(cmd) {
  const c = String(cmd || "").toLowerCase();
  if (c.includes("rg -n")) return "rg";
  // our snippet command is powershell + Get-Content + actionsWrap markers
  if (
    c.includes("powershell") &&
    c.includes("get-content") &&
    c.includes("actionswrap")
  )
    return "snippet";
  if (
    c.includes("=== public/index.html (actionswrap context) ===".toLowerCase())
  )
    return "snippet";
  return "other";
}

/**
 * Collect ONLY inspection outputs that belong to THIS message.
 * This prevents old inspections from polluting the replanning loop.
 */
function collectRunCmdOutputs(actions, currentMessage) {
  const cur = normalizeMsg(currentMessage);

  const out = [];
  for (const a of actions) {
    if (!a || a.type !== "run_cmd") continue;
    if (a.status !== "done") continue;

    // must be a follow-up inspection
    if (a.meta?.followup !== true) continue;

    const omRaw = a.meta?.originalMessage ? String(a.meta.originalMessage) : "";
    const om = normalizeMsg(omRaw);

    // if originalMessage is missing, do NOT include it (avoids legacy cross-talk)
    if (!om) continue;

    // must match this user request (normalized)
    if (om !== cur) continue;

    const r = a.result?.result || a.result || {};
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    if (!stdout && !stderr) continue;

    const cmd = a.payload?.cmd || r.cmd || "";
    const inspectionKind =
      a.meta?.inspectionKind || detectInspectionKindFromCmd(cmd) || "other";

    out.push({
      id: a.id,
      title: a.title || "inspection",
      cmd,
      stdout,
      stderr,
      updatedAt: a.updatedAt || a.createdAt || 0,
      inspectionKind,
    });
  }

  out.sort((x, y) => (x.updatedAt || 0) - (y.updatedAt || 0));
  return out.slice(-6);
}

function deriveInspectionStage(runCmdOutputs) {
  const kinds = new Set((runCmdOutputs || []).map((x) => x.inspectionKind));
  return {
    hasRg: kinds.has("rg"),
    hasSnippet: kinds.has("snippet"),
  };
}

// Note: callers sometimes invoke buildSnapshot() with no args.
// Provide a default parameter to avoid crashing on destructuring.
export async function buildSnapshot({ message, lastIntent } = {}) {
  const actions = listActions();

  const allowlistedFiles = ["public/index.html", "public/styles.css"];
  const rawFiles = {};
  for (const f of allowlistedFiles) {
    const txt = safeRead(f);
    if (typeof txt === "string") rawFiles[f] = txt;
  }

  const msg = String(message || "");
  const runCmdOutputs = collectRunCmdOutputs(actions, msg);
  const inspectionStage = deriveInspectionStage(runCmdOutputs);

  // lightweight selector list (optional)
  const cssSelectors = [];
  const css = rawFiles["public/styles.css"];
  if (css) {
    const re = /(^|\n)\s*([.#][a-zA-Z0-9_-]+)\s*[{,]/g;
    let m;
    while ((m = re.exec(css)) && cssSelectors.length < 250) {
      cssSelectors.push(m[2]);
    }
  }

  const uiFacts = {
    cssFiles: [],
    htmlFiles: [],
  };
  // Provide small grounded excerpts (not full repo) to help the planner
  // select the right selector/file for UI changes.
  if (typeof rawFiles["public/styles.css"] === "string") {
    uiFacts.cssFiles.push({
      path: "public/styles.css",
      bytes: rawFiles["public/styles.css"].length,
      text: rawFiles["public/styles.css"],
    });
  }
  if (typeof rawFiles["public/index.html"] === "string") {
    uiFacts.htmlFiles.push({
      path: "public/index.html",
      bytes: rawFiles["public/index.html"].length,
      text: rawFiles["public/index.html"],
    });
  }

  return {
    message: msg,
    lastIntent: String(lastIntent || "chat"),
    allowlistedFiles,
    rawFiles,
    runCmdOutputs,
    inspectionStage,
    uiMapSummary: { cssSelectors },
    uiFacts,
  };
}
