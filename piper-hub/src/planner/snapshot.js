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
function collectFollowupInspectionOutputs(actions, currentMessage) {
  const cur = normalizeMsg(currentMessage);

  const out = [];
  for (const a of actions) {
    if (!a) continue;
    if (a.type !== "run_cmd" && a.type !== "read_snippet") continue;
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
    const text = typeof r.text === "string" ? r.text : "";
    if (!stdout && !stderr && !text) continue;

    const cmd = a.type === "run_cmd" ? a.payload?.cmd || r.cmd || "" : "read_snippet";
    const inspectionKind =
      a.meta?.inspectionKind ||
      (a.type === "read_snippet" ? "snippet" : detectInspectionKindFromCmd(cmd)) ||
      "other";

    out.push({
      id: a.id,
      title: a.title || "inspection",
      cmd,
      stdout,
      stderr,
      text,
      updatedAt: a.updatedAt || a.createdAt || 0,
      inspectionKind,
    });
  }

  out.sort((x, y) => (x.updatedAt || 0) - (y.updatedAt || 0));
  return out.slice(-6);
}

function parseRg(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  const matches = [];
  for (const line of lines) {
    // Typical rg format: file:line:col:text OR file:line:text
    const m = line.match(/^([^:\n\r]+):(\d+):(\d+):(.*)$/);
    if (m) {
      matches.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), text: m[4] });
      continue;
    }
    const m2 = line.match(/^([^:\n\r]+):(\d+):(.*)$/);
    if (m2) {
      matches.push({ file: m2[1], line: Number(m2[2]), col: 1, text: m2[3] });
    }
  }
  return matches.slice(0, 200);
}

function parseSelectorsFromText(txt) {
  const t = String(txt || "");
  const selectors = new Set();
  // class="a b" and id="x"
  for (const m of t.matchAll(/\bclass\s*=\s*"([^"]{1,500})"/g)) {
    const parts = String(m[1]).split(/\s+/g).filter(Boolean);
    for (const p of parts) selectors.add(`.${p}`);
  }
  for (const m of t.matchAll(/\bid\s*=\s*"([^"]{1,200})"/g)) {
    const id = String(m[1]).trim();
    if (id) selectors.add(`#${id}`);
  }
  return Array.from(selectors).slice(0, 250);
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
  const runCmdOutputs = collectFollowupInspectionOutputs(actions, msg);
  const inspectionStage = deriveInspectionStage(runCmdOutputs);

  // Parse inspection outputs into structured facts for the planner/compiler.
  const rgMatches = [];
  const snippets = [];
  const selectorsFound = new Set();

  for (const o of runCmdOutputs) {
    if (!o) continue;
    if (o.inspectionKind === "rg") {
      const matches = parseRg(o.stdout || "");
      if (matches.length) rgMatches.push({ id: o.id, cmd: o.cmd, matches });
      continue;
    }

    if (o.inspectionKind === "snippet") {
      const text = o.text || o.stdout || "";
      if (text) {
        snippets.push({ id: o.id, title: o.title, text });
        for (const s of parseSelectorsFromText(text)) selectorsFound.add(s);
      }
    }
  }

  const inspectionFacts = {
    rgMatches,
    snippets,
    selectorsFound: Array.from(selectorsFound).slice(0, 250),
  };

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
    inspectionFacts,
    uiMapSummary: { cssSelectors },
    uiFacts,
  };
}
