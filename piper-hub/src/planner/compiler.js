// src/planner/compiler.js
import fs from "fs";
import path from "path";
import { safeResolve } from "../utils/fsx.js";

/**
 * Compile planner JSON ops into executable actions.
 * HARD RULE: return at most ONE approval action (bundle if needed).
 *
 * Also supports:
 * - planner-level no-op/done detection (when ops compile to zero changes)
 * - escalation ladder (queue next inspection step when deterministic change can't be formed)
 */

function normalizePlannedPath(inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) return raw;

  // Already explicit
  if (raw.startsWith("known:")) return raw;

  // Normalize slashes for detection only
  const canon = raw.replaceAll("\\", "/");
  const lower = canon.toLowerCase();

  const map = [
    { key: "desktop", token: "known:desktop" },
    { key: "downloads", token: "known:downloads" },
    { key: "documents", token: "known:documents" },
  ];

  // Handle relative like "Desktop/foo" or "/Desktop/foo"
  for (const { key, token } of map) {
    if (lower === key || lower === `/${key}`) return token;
    if (lower.startsWith(`${key}/`))
      return token + "/" + canon.slice(key.length + 1);
    if (lower.startsWith(`/${key}/`))
      return token + "/" + canon.slice(key.length + 2);
  }

  // Handle absolute Windows paths like "C:\Users\Name\Desktop\Foo"
  // We extract the segment after the known folder name.
  for (const { key, token } of map) {
    const marker = `/${key}/`;
    const pos = lower.indexOf(marker);
    // crude "drive letter" check after slash-normalization: "c:/..."
    if (pos > 2 && /^[a-z]:\//i.test(canon.slice(0, 4))) {
      const tail = canon.slice(pos + marker.length);
      return tail ? `${token}/${tail}` : token;
    }
  }

  return raw;
}

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

function detectInspectionKindFromCmd(cmd) {
  const c = String(cmd || "").toLowerCase();
  if (c.includes("rg -n")) return "rg";
  if (
    c.includes("powershell") &&
    c.includes("get-content") &&
    c.includes("actionswrap")
  )
    return "snippet";
  if (c.includes("=== public/index.html")) return "snippet";
  return "other";
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
 * Find a selector block in CSS using snapshot.uiFacts.cssBlocks if possible,
 * otherwise by a simple regex search on the file.
 *
 * Returns { full, body } or null.
 */
function findCssBlockFromSnapshot(snapshot, selector) {
  const sel = String(selector || "").trim();
  const blocks = snapshot?.uiFacts?.cssBlocks;
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
  cssPath,
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

    if (normalizeWs(nextBody) === normalizeWs(body))
      return { action: null, noop: true };

    const open = full.indexOf("{");
    const close = full.lastIndexOf("}");
    if (open === -1 || close === -1 || close <= open)
      return { action: null, needsMoreContext: true };

    const prefix = full.slice(0, open + 1);
    const suffix = full.slice(close);

    const nextFull = `${prefix}\n${ensureEndsWithNewline(nextBody)}${suffix}`;

    // Use exact substring replace (deterministic)
    return {
      action: {
        type: "apply_patch",
        title,
        reason,
        payload: {
          path: String(cssPath || "public/styles.css"),
          edits: [{ find: full, replace: nextFull, mode: "once" }],
        },
        meta: {
          preview: {
            kind: "css_block",
            selector,
            anchor: full,
            replacement: nextFull,
          },
        },
      },
    };
  }

  // If we can't find a block deterministically, append a safe override block.
  const lines = [];
  for (const [k, v] of Object.entries(set || {})) {
    const prop = String(k).trim();
    const val = String(v ?? "").trim();
    if (prop && val) lines.push(`  ${prop}: ${val};`);
  }
  if (!lines.length) return { action: null, noop: true };

  const appended =
    `\n\n/* Piper auto-override (approval-gated) */\n${selector} {\n` +
    lines.join("\n") +
    `\n}\n`;

  return {
    action: {
      type: "apply_patch",
      title: `CSS override: ${selector}`,
      reason:
        reason ||
        "Could not locate an exact CSS block; appending a minimal override block instead.",
      payload: {
        path: String(cssPath || "public/styles.css"),
        edits: [{ find: "", replace: appended, mode: "append" }],
      },
      meta: {
        allowAppend: true,
        preview: {
          kind: "css_append",
          selector,
          anchor: "",
          replacement: appended,
        },
      },
    },
  };
}

function compileCssPatch({ snapshot, op }) {
  const selectors = Array.isArray(op.selectors) ? op.selectors : [];
  const selector = String(selectors[0] || "").trim();
  if (!selector) return { action: null, needsMoreContext: true };

  const set = op.set && typeof op.set === "object" ? op.set : {};
  const unset = Array.isArray(op.unset) ? op.unset : [];
  const why = String(op.why || "CSS update").trim();

  const cssPath =
    snapshot?.uiFacts?.cssFiles?.[0]?.path || "public/styles.css";
  const cssText =
    (snapshot?.rawFiles && snapshot.rawFiles[cssPath]) ||
    readFileText(cssPath);

  const built = buildCssApplyPatch({
    cssText,
    selector,
    title: `CSS patch: ${selector}`,
    reason: why,
    set,
    unset,
    snapshot,
    cssPath,
  });

  if (built.action) {
    console.log(
      `[compiler] compile css_patch selector="${selector}" -> ${built.action.type}`
    );
  } else {
    console.log(
      `[compiler] compile css_patch selector="${selector}" -> (no-op/needs-context)`
    );
  }

  return built;
}

function applyPatchInMemoryForCompile(before, edits) {
  let out = String(before ?? "");
  let changedAny = false;
  let anyUnmatched = false;

  for (const e of edits || []) {
    const find = String(e?.find ?? "");
    const replace = String(e?.replace ?? "");
    const mode =
      e?.mode === "all" ? "all" : e?.mode === "append" ? "append" : "once";

    if (mode === "append") {
      out = out + replace;
      changedAny = true;
      continue;
    }

    if (!find) {
      anyUnmatched = true;
      continue;
    }

    if (mode === "all") {
      const matched = out.includes(find);
      if (!matched) anyUnmatched = true;
      const next = matched ? out.split(find).join(replace) : out;
      if (next !== out) changedAny = true;
      out = next;
      continue;
    }

    // once
    const idx = out.indexOf(find);
    if (idx === -1) {
      anyUnmatched = true;
      continue;
    }
    out = out.slice(0, idx) + replace + out.slice(idx + find.length);
    changedAny = true;
  }

  return { out, changedAny, anyUnmatched };
}

function compileApplyPatchOp({ snapshot, op }) {
  const p = String(op?.path || "").trim();
  const edits = Array.isArray(op?.edits) ? op.edits : [];
  const why = String(op?.why || "Apply patch").trim();

  if (!p || !edits.length) return { action: null, needsMoreContext: true };

  const before =
    (snapshot?.rawFiles && typeof snapshot.rawFiles[p] === "string"
      ? snapshot.rawFiles[p]
      : readFileText(p)) || "";

  const sim = applyPatchInMemoryForCompile(before, edits);

  // If patch cannot match, ask for more context (escalation ladder handles it)
  if (!sim.changedAny) {
    // if it was just already equal, treat as noop
    if (!sim.anyUnmatched) return { action: null, noop: true };
    return { action: null, needsMoreContext: true };
  }

  console.log(
    `[compiler] compile apply_patch path="${p}" edits=${edits.length}`
  );

  return {
    action: {
      type: "apply_patch",
      title: `Patch: ${p}`,
      reason: why,
      payload: { path: p, edits },
      meta: {
        preview: {
          kind: "apply_patch",
          path: p,
        },
      },
    },
  };
}

function compileWriteFileOp({ snapshot, op }) {
  const p = normalizePlannedPath(String(op?.path || "").trim());
  const content = String(op?.content ?? "");
  const why = String(op?.why || "Write file").trim();
  if (!p) return { action: null, needsMoreContext: true };

  const oldText =
    (snapshot?.rawFiles && typeof snapshot.rawFiles[p] === "string"
      ? snapshot.rawFiles[p]
      : (() => {
          try {
            return readFileText(p);
          } catch {
            return "";
          }
        })()) || "";

  if (oldText === content) return { action: null, noop: true };

  console.log(
    `[compiler] compile write_file path="${p}" bytes=${content.length}`
  );

  return {
    action: {
      type: "write_file",
      title: `Write file: ${p}`,
      reason: why,
      payload: { path: p, content },
      meta: {
        preview: {
          kind: "write_file",
          path: p,
        },
      },
    },
  };
}

function compileMkdirOp({ op }) {
  const p = normalizePlannedPath(String(op?.path || "").trim());
  const why = String(op?.why || "Create folder").trim();
  if (!p) return { action: null, needsMoreContext: true };

  console.log(`[compiler] compile mkdir path="${p}"`);

  return {
    action: {
      type: "mkdir",
      title: `Create folder: ${p}`,
      reason: why,
      payload: { path: p },
    },
  };
}

function compileRunCmdOp({ snapshot, op }) {
  const cmd = String(op?.cmd || "").trim();
  if (!cmd) return { action: null, needsMoreContext: true };

  const timeoutMs =
    typeof op?.timeoutMs === "number" ? Math.max(1000, op.timeoutMs) : 12000;
  const why = String(op?.why || "Run command").trim();

  const originalMessage = String(snapshot?.message || "");

  return {
    action: {
      type: "run_cmd",
      title: `Run: ${cmd}`,
      reason: why,
      payload: { cmd, timeoutMs },
      meta: {
        followup: true,
        originalMessage,
        inspectionKind: detectInspectionKindFromCmd(cmd),
      },
    },
  };
}

function compileReadSnippetOp({ snapshot, op }) {
  const p = normalizePlannedPath(String(op?.path || "").trim());
  if (!p) return { action: null, needsMoreContext: true };

  const originalMessage = String(snapshot?.message || "");

  return {
    action: {
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
      meta: {
        followup: true,
        originalMessage,
        inspectionKind: "snippet",
      },
    },
  };
}

function bundleActions(actions, reason = "Bundled actions") {
  return {
    type: "bundle",
    title: "Bundle",
    reason,
    payload: {
      actions,
    },
  };
}

function queueEscalationInspection({ snapshot, reason }) {
  // Escalation ladder:
  // step 0: rg
  // step 1: snippet around best rg hit
  // step 2: broader snippet or fallback
  // then stop
  const stage = snapshot?.inspectionStage || {};
  const step = Number(stage?.step || 0);

  const msg = String(snapshot?.message || "");
  const baseWhy =
    reason ||
    "I can’t form a deterministic patch yet; I need more grounding context.";

  // If we already have a snippet, do not loop; ask for clarification
  if (stage.hasSnippet) {
    return {
      done: true,
      reply:
        "I inspected the relevant files but still can’t form a deterministic patch safely. Can you tell me exactly which file/section to change (or paste the relevant block), sir?",
      actions: [],
      stage: { escalated: true, step, stopped: true },
    };
  }

  // If we have rg hits, request a snippet around the first good hit
  const rgMatches =
    snapshot?.inspectionFacts?.rgMatches?.[0]?.matches ||
    snapshot?.inspectionFacts?.rgMatches?.flatMap((x) => x.matches || []) ||
    [];

  if (stage.hasRg && rgMatches.length) {
    const hit = rgMatches[0];
    const hitFile = String(hit.file || "").trim();
    const hitLine = Number(hit.line || 1);

    if (hitFile) {
      const read = compileReadSnippetOp({
        snapshot,
        op: {
          op: "read_snippet",
          path: hitFile,
          aroundLine: hitLine,
          radius: 80,
          why: baseWhy,
        },
      });

      if (read.action) {
        return {
          done: false,
          reply:
            "I need a little more context before I can apply a safe, deterministic change. I’ll grab a focused snippet next, sir.",
          actions: [read.action],
          stage: { escalated: true, step: step + 1 },
        };
      }
    }
  }

  // Otherwise start with rg over likely places
  const rg = compileRunCmdOp({
    snapshot,
    op: {
      op: "run_cmd",
      cmd: 'rg -n "Desktop|Downloads|Documents|mkdir\\(|write_file|known:desktop|known:downloads|known:documents" src public',
      timeoutMs: 12000,
      why: baseWhy,
    },
  });

  if (rg.action) {
    return {
      done: false,
      reply:
        "I don’t have enough grounded context yet. I’ll inspect the codebase first, sir.",
      actions: [rg.action],
      stage: { escalated: true, step: step + 1 },
    };
  }

  return {
    done: true,
    reply:
      "I can’t proceed safely without more context. Please paste the relevant file section, sir.",
    actions: [],
    stage: { escalated: true, step, stopped: true },
  };
}

export function compilePlanToActions({ snapshot, plan }) {
  const ops = Array.isArray(plan?.ops) ? plan.ops : [];
  const needsApproval = plan?.requiresApproval === true;

  const compiled = [];
  let noopCount = 0;
  let needsMoreContext = false;

  for (const op of ops) {
    let built = { action: null };

    if (op.op === "css_patch") built = compileCssPatch({ snapshot, op });
    else if (op.op === "apply_patch")
      built = compileApplyPatchOp({ snapshot, op });
    else if (op.op === "write_file")
      built = compileWriteFileOp({ snapshot, op });
    else if (op.op === "mkdir") built = compileMkdirOp({ op });
    else if (op.op === "run_cmd") built = compileRunCmdOp({ snapshot, op });
    else if (op.op === "read_snippet")
      built = compileReadSnippetOp({ snapshot, op });
    else if (op.op === "restart") {
      built = {
        action: {
          type: "restart",
          title: "Restart Piper",
          reason: String(op?.why || "Restart requested").trim(),
          payload: {},
        },
      };
    } else if (op.op === "off") {
      built = {
        action: {
          type: "off",
          title: "Turn off Piper",
          reason: String(op?.why || "Shutdown requested").trim(),
          payload: {},
        },
      };
    }

    if (built?.noop) noopCount += 1;
    if (built?.needsMoreContext) needsMoreContext = true;
    if (built?.action) compiled.push(built.action);
  }

  // If approval is expected but we produced nothing actionable, do NOT
  // claim success. Instead, queue a single grounding inspection.
  if (compiled.length === 0 && needsApproval) {
    return queueEscalationInspection({
      snapshot,
      reason:
        "Planner couldn’t form a deterministic action from current context.",
    });
  }

  // HARD RULE: at most ONE approval action (bundle if needed)
  if (compiled.length > 1) {
    return {
      done: false,
      reply:
        plan?.reply ||
        "I’ve prepared a small bundle of actions for approval, sir.",
      actions: [bundleActions(compiled, plan?.reply || "Bundled actions")],
      stage: plan?.stage || {},
    };
  }

  return {
    done: false,
    reply: plan?.reply || "Ready for approval, sir.",
    actions: compiled,
    stage: plan?.stage || {},
  };
}
