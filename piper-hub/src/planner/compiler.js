// src/planner/compiler.js
import fs from "fs";
import path from "path";
import { findCssBlock, normalizeWs } from "./uimapper.js";
import { safeResolve } from "../utils/fsx.js";

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

  if (!v) return stripDecl(body, p);

  const re = new RegExp(`^(\\s*)${escapeRegExp(p)}\\s*:\\s*[^;]+;\\s*$`, "gmi");
  if (re.test(body)) {
    return String(body).replace(re, `$1${p}: ${v};`);
  }

  let b = ensureEndsWithNewline(String(body));
  b += `  ${p}: ${v};\n`;
  return b;
}

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

  const nextFull = prefix + "\n" + newBody + suffix;

  return {
    type: "apply_patch",
    title,
    reason,
    payload: {
      path: uiMap.cssFile,
      edits: [{ find: full, replace: nextFull, mode: "once" }],
    },
  };
}

function compileCssPatch({ snapshot, op }) {
  const uiMap = snapshot?.uiMap;
  if (!uiMap) return null;

  const selectors = Array.isArray(op.selectors) ? op.selectors : [];
  const set = op.set && typeof op.set === "object" ? op.set : {};
  const unset = Array.isArray(op.unset) ? op.unset : [];

  const selector = String(selectors[0] || "").trim();
  if (!selector) return null;

  const title = `CSS patch: ${selector}`;
  const reason = String(op.why || "CSS update").trim();

  return buildCssApplyPatch({
    uiMap,
    selector,
    title,
    reason,
    editFn: (body) => {
      let out = String(body || "");
      for (const prop of unset) out = stripDecl(out, prop);
      for (const [k, v] of Object.entries(set)) out = setDecl(out, k, v);
      return out;
    },
  });
}

function compileWriteFileOp({ op }) {
  let p = String(op?.path || "").trim();
  const content = String(op?.content ?? "");
  const why = String(op?.why || "Write file").trim();
  if (!p) return null;

  // ✅ Heuristic: if path is "folder/file.txt" and that folder exists in Downloads,
  // automatically map it to known:downloads/folder/file.txt
  // This makes: "put it in the piper-tests folder" work after you created it in Downloads.
  if (!p.startsWith("known:") && !path.isAbsolute(p)) {
    const firstSeg = p.split(/[\\/]/).filter(Boolean)[0];
    if (firstSeg) {
      try {
        const downloadsFolderAbs = safeResolve(`known:downloads/${firstSeg}`);
        if (
          fs.existsSync(downloadsFolderAbs) &&
          fs.statSync(downloadsFolderAbs).isDirectory()
        ) {
          const mapped = `known:downloads/${p.replaceAll("\\", "/")}`;
          console.log(
            `[compiler] write_file mapped to downloads: "${p}" -> "${mapped}"`
          );
          p = mapped;
        }
      } catch {
        // ignore mapping failures
      }
    }
  }

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

function forceSingleApproval(actions, reply) {
  const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
  if (list.length <= 1) return list;

  return [
    {
      type: "bundle",
      title: "Bundle: multiple steps",
      reason: String(reply || "Multiple steps required.").trim(),
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
  }

  actions = forceSingleApproval(actions, plan?.reply);

  return {
    reply: String(plan?.reply || "Queued for approval, sir."),
    actions,
  };
}
