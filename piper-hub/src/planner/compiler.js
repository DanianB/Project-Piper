// src/planner/compiler.js
import fs from "fs";
import path from "path";
import { safeResolve } from "../utils/fsx.js";

/**
 * Compile planner JSON ops into executable actions.
 * HARD RULE: return at most ONE approval action (bundle if needed).
 */

function ensureEndsWithNewline(s) {
  s = String(s || "");
  return s.endsWith("\n") ? s : s + "\n";
}

function normalizeWs(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripDecl(body, prop) {
  const p = String(prop || "").trim();
  if (!p) return body;
  return String(body).replace(
    new RegExp(`^\\s*${escapeRegExp(p)}\\s*:\\s*[^;]+;\\s*$`, "gmi"),
    ""
  );
}

function setDecl(body, prop, value) {
  const p = String(prop || "").trim();
  const v = String(value ?? "").trim();
  if (!p) return body;

  if (!v) return stripDecl(body, p);

  const re = new RegExp(`^(\\s*)${escapeRegExp(p)}\\s*:\\s*[^;]+;\\s*$`, "gmi");
  if (re.test(body)) {
    return String(body).replace(re, `$1${p}: ${v};`);
  }

  let b = ensureEndsWithNewline(String(body));
  b += `  ${p}: ${v};\n`;
  return b;
}

function readFileText(relPath) {
  const abs = safeResolve(relPath);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

/**
 * Find a selector block in CSS using snapshot.uiMap.cssBlocks if possible,
 * otherwise by a simple regex search on the file.
 *
 * Returns { full, body } or null.
 */
function findCssBlockFromSnapshot(snapshot, selector) {
  const sel = String(selector || "").trim();
  const blocks = snapshot?.uiMap?.cssBlocks;
  if (Array.isArray(blocks)) {
    const b = blocks.find((x) => String(x?.selector || "").trim() === sel);
    if (b && typeof b.full === "string" && typeof b.body === "string") {
      return { full: b.full, body: b.body };
    }
  }
  return null;
}

function findCssBlockByRegex(cssText, selector) {
  const sel = String(selector || "").trim();
  if (!sel) return null;

  // Very simple: match `selector { ... }` non-greedily.
  // Works for normal blocks (not nested preprocessor).
  const re = new RegExp(
    `(^|\\n)\\s*${escapeRegExp(sel)}\\s*\\{([\\s\\S]*?)\\}\\s*`,
    "m"
  );

  const m = cssText.match(re);
  if (!m) return null;

  const full = m[0].startsWith("\n") ? m[0].slice(1) : m[0];
  const body = m[2] || "";
  return { full, body };
}

function buildCssApplyPatch({
  cssText,
  selector,
  title,
  reason,
  set,
  unset,
  snapshot,
}) {
  // 1) Try snapshot blocks first (best chance for exact find string)
  let block = findCssBlockFromSnapshot(snapshot, selector);

  // 2) Fallback to regex parse from file
  if (!block) block = findCssBlockByRegex(cssText, selector);

  // If we found a block, try to edit it
  if (block) {
    const full = String(block.full || "");
    const body = String(block.body || "");

    let nextBody = String(body);
    for (const prop of Array.isArray(unset) ? unset : [])
      nextBody = stripDecl(nextBody, prop);
    for (const [k, v] of Object.entries(set || {}))
      nextBody = setDecl(nextBody, k, v);

    if (normalizeWs(nextBody) === normalizeWs(body)) return null;

    const open = full.indexOf("{");
    const close = full.lastIndexOf("}");
    if (open === -1 || close === -1 || close <= open) return null;

    const prefix = full.slice(0, open + 1);
    const suffix = full.slice(close);

    const nextFull = `${prefix}\n${ensureEndsWithNewline(nextBody)}${suffix}`;

    // Use exact substring replace (deterministic)
    return {
      type: "apply_patch",
      title,
      reason,
      payload: {
        path: "public/styles.css",
        edits: [{ find: full, replace: nextFull, mode: "once" }],
      },
    };
  }

  // If we can't find a block deterministically, append a safe override block.
  // This is still grounded (we are only adding a new block with the selector).
  const lines = [];
  for (const [k, v] of Object.entries(set || {})) {
    const prop = String(k).trim();
    const val = String(v ?? "").trim();
    if (prop && val) lines.push(`  ${prop}: ${val};`);
  }
  if (!lines.length) return null;

  const appended =
    `\n\n/* Piper auto-override (approval-gated) */\n${selector} {\n` +
    lines.join("\n") +
    `\n}\n`;

  return {
    type: "apply_patch",
    title: `CSS override: ${selector}`,
    reason:
      reason ||
      "Could not locate an exact CSS block; appending a minimal override block instead.",
    payload: {
      path: "public/styles.css",
      edits: [{ find: "", replace: appended, mode: "append" }],
    },
    meta: { allowAppend: true },
  };
}

function compileCssPatch({ snapshot, op }) {
  const selectors = Array.isArray(op.selectors) ? op.selectors : [];
  const selector = String(selectors[0] || "").trim();
  if (!selector) return null;

  const set = op.set && typeof op.set === "object" ? op.set : {};
  const unset = Array.isArray(op.unset) ? op.unset : [];
  const why = String(op.why || "CSS update").trim();

  const cssText =
    (snapshot?.rawFiles && snapshot.rawFiles["public/styles.css"]) ||
    readFileText("public/styles.css");

  const action = buildCssApplyPatch({
    cssText,
    selector,
    title: `CSS patch: ${selector}`,
    reason: why,
    set,
    unset,
    snapshot,
  });

  if (action) {
    console.log(
      `[compiler] compile css_patch selector="${selector}" -> ${action.type}`
    );
  } else {
    console.log(
      `[compiler] compile css_patch selector="${selector}" -> (no-op)`
    );
  }

  return action;
}

function compileApplyPatchOp({ op }) {
  const p = String(op?.path || "").trim();
  const edits = Array.isArray(op?.edits) ? op.edits : [];
  const why = String(op?.why || "Apply patch").trim();
  if (!p || !edits.length) return null;

  return {
    type: "apply_patch",
    title: `Patch: ${p}`,
    reason: why,
    payload: { path: p, edits },
  };
}

function compileWriteFileOp({ op }) {
  let p = String(op?.path || "").trim();
  const content = String(op?.content ?? "");
  const why = String(op?.why || "Write file").trim();
  if (!p) return null;

  console.log(
    `[compiler] compile write_file path="${p}" bytes=${content.length}`
  );

  return {
    type: "write_file",
    title: `Write file: ${p}`,
    reason: why,
    payload: { path: p, content },
  };
}

function compileMkdirOp({ op }) {
  const p = String(op?.path || "").trim();
  const why = String(op?.why || "Create folder").trim();
  if (!p) return null;

  console.log(`[compiler] compile mkdir path="${p}"`);

  return {
    type: "mkdir",
    title: `Create folder: ${p}`,
    reason: why,
    payload: { path: p },
  };
}

function compileRunCmdOp({ op }) {
  const cmd = String(op?.cmd || "").trim();
  if (!cmd) return null;

  const timeoutMs =
    typeof op?.timeoutMs === "number" ? Math.max(1000, op.timeoutMs) : 12000;
  const why = String(op?.why || "Run command").trim();

  return {
    type: "run_cmd",
    title: `Run: ${cmd}`,
    reason: why,
    payload: { cmd, timeoutMs },
  };
}

function compileReadSnippetOp({ op }) {
  const p = String(op?.path || "").trim();
  if (!p) return null;

  return {
    type: "read_snippet",
    title: `Read snippet: ${p}`,
    reason: String(op?.why || "Inspect file region").trim(),
    payload: {
      path: p,
      ...(op.aroundLine != null ? { aroundLine: Number(op.aroundLine) } : {}),
      ...(op.radius != null ? { radius: Number(op.radius) } : {}),
      ...(op.startLine != null ? { startLine: Number(op.startLine) } : {}),
      ...(op.endLine != null ? { endLine: Number(op.endLine) } : {}),
      maxLines: Number(op.maxLines || 240),
    },
  };
}

function forceSingleApproval(actions) {
  const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
  if (list.length <= 1) return list;

  return [
    {
      type: "bundle",
      title: "Queued changes (bundle)",
      reason:
        "Multiple safe edits are required; bundling into a single approval item.",
      payload: { steps: list },
    },
  ];
}

export function compilePlanToActions({ plan, snapshot, readOnly }) {
  if (readOnly) {
    return {
      reply:
        "Read-only is enabled, sir. I can outline what to change, but I won’t queue actions.",
      actions: [],
    };
  }

  const ops = Array.isArray(plan?.ops) ? plan.ops : [];
  let actions = [];

  for (const op of ops) {
    if (!op || typeof op !== "object") continue;

    if (op.op === "css_patch") {
      const a = compileCssPatch({ snapshot, op });
      if (a) actions.push(a);
      continue;
    }

    if (op.op === "apply_patch") {
      const a = compileApplyPatchOp({ op });
      if (a) actions.push(a);
      continue;
    }

    if (op.op === "write_file") {
      const a = compileWriteFileOp({ op });
      if (a) actions.push(a);
      continue;
    }

    if (op.op === "mkdir") {
      const a = compileMkdirOp({ op });
      if (a) actions.push(a);
      continue;
    }

    if (op.op === "run_cmd") {
      const a = compileRunCmdOp({ op });
      if (a) actions.push(a);
      continue;
    }

    if (op.op === "read_snippet") {
      const a = compileReadSnippetOp({ op });
      if (a) actions.push(a);
      continue;
    }
  }

  actions = forceSingleApproval(actions);

  return {
    reply: String(plan?.reply || "Queued for approval, sir."),
    actions,
  };
}
