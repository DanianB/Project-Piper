// src/planner/compiler.js
import { findCssBlock, normalizeWs } from "./uimapper.js";

function ensureEndsWithNewline(s) {
  s = String(s || "");
  return s.endsWith("\n") ? s : s + "\n";
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

  // empty value => unset
  if (!v) return stripDecl(body, p);

  const re = new RegExp(`^(\\s*)${escapeRegExp(p)}\\s*:\\s*[^;]+;\\s*$`, "gmi");
  if (re.test(body)) {
    return String(body).replace(re, `$1${p}: ${v};`);
  }

  // append with consistent indentation
  let b = ensureEndsWithNewline(String(body));
  b += `  ${p}: ${v};\n`;
  return b;
}

/**
 * Build a patch that:
 * - matches the EXACT selector block text already in the file
 * - replaces ONLY the body (between braces)
 * - preserves existing selector formatting + whitespace
 *
 * This prevents preview highlighting half the stylesheet due to reformatting.
 */
function buildCssApplyPatch({ uiMap, selector, title, reason, editFn }) {
  const block = findCssBlock(uiMap.cssBlocks, selector);
  if (!block) return null;

  const full = String(block.full || "");
  const body = String(block.body || "");

  const newBody = editFn(body);

  if (normalizeWs(newBody) === normalizeWs(body)) return null;

  const open = full.indexOf("{");
  const close = full.lastIndexOf("}");
  if (open === -1 || close === -1 || close <= open) return null;

  const prefix = full.slice(0, open + 1);
  const suffix = full.slice(close);

  const newFull = prefix + newBody + suffix;
  if (newFull === full) return null;

  return {
    type: "apply_patch",
    title,
    reason,
    payload: {
      path: "public/styles.css",
      edits: [{ find: full, replace: newFull, mode: "once" }],
    },
  };
}

/**
 * Deterministically append a rule at end of file.
 * Uses a tail anchor so apply_patch has a stable match.
 */
function appendCssRule({ snapshot, file, selector, decls, title, reason }) {
  const css = String(snapshot.rawFiles?.[file] || "");
  if (!css) return null;

  const tailLen = Math.min(260, css.length);
  const tail = css.slice(-tailLen);

  const rule =
    `\n\n/* Piper override */\n${selector} {\n` +
    decls.map((d) => `  ${d}`).join("\n") +
    `\n}\n`;

  return {
    type: "apply_patch",
    title,
    reason,
    payload: {
      path: file,
      edits: [{ find: tail, replace: tail + rule, mode: "once" }],
    },
  };
}

/**
 * General-purpose CSS patch op.
 *
 * op example:
 * {
 *   op: "css_patch",
 *   file: "public/styles.css",
 *   selectors: [".btn-secondary", ".btn-secondary:hover"],
 *   set: {"background":"transparent"},
 *   unset: ["box-shadow"]
 * }
 */
function compileCssPatch({ snapshot, op }) {
  const file = String(op.file || "public/styles.css");
  const selectors = Array.isArray(op.selectors)
    ? op.selectors.map((s) => String(s || "").trim()).filter(Boolean)
    : [];

  const setObj = op.set && typeof op.set === "object" ? op.set : {};
  const unsetArr = Array.isArray(op.unset) ? op.unset : [];

  if (!selectors.length) return null;
  if (!file.endsWith(".css")) return null;

  const actions = [];

  for (const selector of selectors) {
    const title = `CSS patch: ${selector}`;
    const reason = String(op.why || "Apply requested CSS change.");

    // Prefer in-place edit if selector exists
    const a = buildCssApplyPatch({
      uiMap: snapshot.uiMap,
      selector,
      title,
      reason,
      editFn: (body) => {
        let b = String(body);

        // Unset first
        for (const prop of unsetArr) b = stripDecl(b, prop);

        // Then set
        for (const [prop, value] of Object.entries(setObj)) {
          b = setDecl(b, prop, value);
        }

        return b;
      },
    });

    if (a) {
      actions.push(a);
      continue;
    }

    // No matching selector block => append override rule
    const decls = [];

    for (const prop of unsetArr) {
      const p = String(prop || "").trim();
      if (p) decls.push(`${p}: unset;`);
    }

    for (const [prop, value] of Object.entries(setObj)) {
      const p = String(prop || "").trim();
      const v = String(value ?? "").trim();
      if (!p) continue;
      if (!v) decls.push(`${p}: unset;`);
      else decls.push(`${p}: ${v};`);
    }

    const appended = appendCssRule({
      snapshot,
      file,
      selector,
      decls,
      title: `Add CSS override: ${selector}`,
      reason: "Selector block not found; append a safe override rule.",
    });

    if (appended) actions.push(appended);
  }

  if (!actions.length) return null;
  if (actions.length === 1) return actions[0];

  return {
    type: "bundle",
    title: "CSS patch bundle",
    reason: String(op.why || "Apply requested CSS changes."),
    payload: { steps: actions },
  };
}

function compileEditFileOp({ snapshot, op }) {
  const file = String(op.file || "");
  const blockId = String(op.blockId || "");
  const newText = String(op.newText ?? "");
  const why = String(op.why || "Apply a grounded edit to the codebase.");

  if (!file || !blockId) return null;

  const block = snapshot.blocks.find((b) => b.blockId === blockId);
  if (!block) return null;
  if (file !== block.file) return null;

  const find = String(block.text || "");
  if (!find) return null;

  if (!newText || newText === find) return null;

  return {
    type: "apply_patch",
    title: `Edit ${file} (${block.kind}: ${block.label})`,
    reason: why,
    payload: { path: file, edits: [{ find, replace: newText, mode: "once" }] },
  };
}

function compileWriteFileOp({ op }) {
  const path = String(op.path || op.file || "").trim();
  const content = String(op.content ?? "");

  if (!path) return null;

  return {
    type: "write_file",
    title: `Write file: ${path}`,
    reason: String(op.why || "Write/update a file as requested."),
    payload: { path, content },
  };
}

/**
 * Optional legacy bridge: ui_change -> css_patch
 * Keeps backwards compatibility, but does not constrain Piper.
 */
function compileLegacyUiChange({ snapshot, op }) {
  const label = op.target?.label || "send";
  const kind = op.change?.kind || "";
  const value = op.change?.value || "";

  // Use index hits + uiMap buttons to propose selectors
  // (Prefer class-based selectors; safer than guessing)
  const btn = snapshot.uiMap.buttons.find((b) => {
    const t = String(b.text || "").toLowerCase();
    const want = String(label || "").toLowerCase();
    return t === want || t.includes(want);
  });

  if (!btn) return null;

  const selectors = [];
  if (btn.id) {
    selectors.push(`#${btn.id}`, `#${btn.id}:hover`, `#${btn.id}:active`);
  }
  for (const c of btn.classes || []) {
    selectors.push(
      `.${c}`,
      `.${c}:hover`,
      `.${c}:active`,
      `button.${c}`,
      `button.${c}:hover`
    );
  }

  if (!selectors.length) return null;

  if (kind === "remove_background") {
    return compileCssPatch({
      snapshot,
      op: {
        op: "css_patch",
        file: "public/styles.css",
        selectors,
        set: { "background-color": "transparent", background: "transparent" },
        unset: [],
        why: op.why || `Remove background for "${label}".`,
      },
    });
  }

  if (kind === "set_background") {
    const val = String(value || "").trim() || "black";
    return compileCssPatch({
      snapshot,
      op: {
        op: "css_patch",
        file: "public/styles.css",
        selectors,
        set: { "background-color": val, background: val },
        unset: [],
        why: op.why || `Set background for "${label}" to ${val}.`,
      },
    });
  }

  return null;
}

export function compilePlanToActions({ plan, snapshot, readOnly }) {
  const actions = [];

  if (readOnly) {
    return {
      reply:
        "Read-only is enabled, sir. I can outline what to change, but I won’t queue actions.",
      actions: [],
    };
  }

  for (const op of plan.ops || []) {
    if (!op || typeof op !== "object") continue;

    if (op.op === "restart") {
      actions.push({
        type: "restart_piper",
        title: "Restart Piper",
        reason: op.why || "User requested a restart.",
        payload: {},
      });
      continue;
    }

    if (op.op === "shutdown") {
      actions.push({
        type: "shutdown_piper",
        title: "Turn Piper off",
        reason: op.why || "User requested shutdown.",
        payload: {},
      });
      continue;
    }

    if (op.op === "run_cmd") {
      actions.push({
        type: "run_cmd",
        title: op.title || "Run command",
        reason: op.why || "Gather info to ground a safe change.",
        payload: {
          cmd: String(op.cmd || ""),
          timeoutMs: Number(op.timeoutMs || 12000),
        },
      });
      continue;
    }

    // ✅ General CSS patch (NOT button-specific)
    if (op.op === "css_patch") {
      const a = compileCssPatch({ snapshot, op });
      if (a) actions.push(a);
      continue;
    }

    // ✅ General file editing by blockId
    if (op.op === "edit_file") {
      const a = compileEditFileOp({ snapshot, op });
      if (a) actions.push(a);
      continue;
    }

    // ✅ Create/update entire files (new features/modules/config)
    if (op.op === "write_file") {
      const a = compileWriteFileOp({ op });
      if (a) actions.push(a);
      continue;
    }

    // Legacy support
    if (op.op === "ui_change") {
      const a = compileLegacyUiChange({ snapshot, op });
      if (a) actions.push(a);
      continue;
    }
  }

  if (!actions.length) {
    // This is the “don’t be rigid” part: encourage a grounded inspection rather than refusing.
    return {
      reply:
        "Sir, I can’t safely ground the exact edit from the current snapshot. I’ll queue a quick inspection command to locate the relevant code/styles, then propose a minimal patch for approval.",
      actions: [
        {
          type: "run_cmd",
          title: "Inspect codebase for relevant UI/code",
          reason:
            "Locate the selector/component/routes related to the request.",
          payload: {
            cmd: 'rg -n "Recent Actions|recent-actions|btn-secondary|send|talk|sidebar|actions" public src -S',
            timeoutMs: 12000,
          },
        },
      ],
    };
  }

  return { reply: String(plan.reply || "Queued for approval, sir."), actions };
}
