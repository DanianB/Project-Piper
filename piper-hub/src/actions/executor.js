import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { ACTIONS_DIR } from "../config/paths.js";
import { safeResolve, ensureDirForFile } from "../utils/fsx.js";

function actionBackupDir(actionId) {
  const d = path.join(ACTIONS_DIR, actionId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeBackup(actionId, targetPath) {
  const d = actionBackupDir(actionId);
  const base = path.basename(targetPath);
  const stamp = Date.now();
  const backupPath = path.join(d, `${base}.${stamp}.bak`);
  fs.copyFileSync(targetPath, backupPath);
  return backupPath;
}

// ✅ IMPORTANT: actions.js imports this — keep it exported.
export function restoreBackup(targetPath, backupPath) {
  if (!fs.existsSync(backupPath)) throw new Error("Backup not found");
  ensureDirForFile(targetPath);
  fs.copyFileSync(backupPath, targetPath);
}

/**
 * Apply a single patch edit.
 * mode: "once" | "all"
 * Returns { out, matched, changed }
 */
function applyPatchOnce(text, find, replace, mode = "once") {
  if (!find) return { out: text, matched: false, changed: false };

  if (mode === "all") {
    const matched = text.includes(find);
    if (!matched) return { out: text, matched: false, changed: false };
    const out = text.split(find).join(replace);
    return { out, matched: true, changed: out !== text };
  }

  const idx = text.indexOf(find);
  if (idx === -1) return { out: text, matched: false, changed: false };
  const out = text.slice(0, idx) + replace + text.slice(idx + find.length);
  return { out, matched: true, changed: out !== text };
}

function coerceBundleSteps(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.steps)) return payload.steps;
  if (Array.isArray(payload.actions)) return payload.actions;
  return [];
}

function runCmd(cmd, timeoutMs = 12000) {
  return new Promise((resolve) => {
    exec(
      cmd,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 * 10 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      }
    );
  });
}

export async function executeAction(action, _depth = 0) {
  const startedAt = Date.now();
  const log = [];
  const push = (s) => log.push(`[${new Date().toISOString()}] ${s}`);

  const actionId = String(action?.id || "act");
  const type = String(action?.type || "");
  const p = action?.payload || {};

  // prevent accidental infinite recursion in bundles
  if (_depth > 10) {
    return {
      ok: false,
      tookMs: Date.now() - startedAt,
      log,
      error: "bundle recursion limit reached",
    };
  }

  try {
    // ---------------- run_cmd --------
    if (type === "run_cmd") {
      const cmd = String(p.cmd || "").trim();
      if (!cmd) throw new Error("run_cmd requires payload.cmd");

      const timeoutMs = Number(p.timeoutMs || 12000);
      push(`run_cmd: ${cmd}`);
      const r = await runCmd(cmd, timeoutMs);

      push(`run_cmd: ok=${r.ok} code=${r.code}`);
      if (r.stdout) push(`stdout: ${r.stdout.slice(0, 6000)}`);
      if (r.stderr) push(`stderr: ${r.stderr.slice(0, 6000)}`);

      return {
        ok: r.ok,
        tookMs: Date.now() - startedAt,
        log,
        result: r,
      };
    }

    // ---------------- restart/shutdown (signal only) --------
    if (type === "restart_piper") {
      push("restart_piper: approved (signal only)");
      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: { restartRequested: true },
      };
    }

    if (type === "shutdown_piper") {
      push("shutdown_piper: approved (signal only)");
      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: { offRequested: true },
      };
    }

    // ---------------- read_snippet --------
    if (type === "read_snippet") {
      const relRaw = String(p.path || "").trim();
      const rel = relRaw.replace(/\\/g, "/");
      if (!rel) throw new Error("read_snippet: missing payload.path");

      // Allowlist: only src/** and public/**
      const allowed = rel.startsWith("src/") || rel.startsWith("public/");
      const denied =
        rel === ".env" ||
        rel.endsWith("/.env") ||
        rel.includes("/.env.") ||
        rel.includes("node_modules/") ||
        rel.startsWith("data/") ||
        rel.includes("..");

      if (!allowed || denied) {
        throw new Error(`read_snippet: path not allowed: ${relRaw}`);
      }

      const target = safeResolve(rel);
      if (!fs.existsSync(target)) {
        throw new Error(`read_snippet: file not found: ${relRaw}`);
      }

      const raw = fs.readFileSync(target, "utf8");
      const lines = raw.split(/\r?\n/);

      // Line addressing is 1-based in payload
      const maxLines = Number(p.maxLines || 240);
      const hardMaxLines = 400;
      const capLines = Math.min(Math.max(1, maxLines), hardMaxLines);

      let startLine = 1;
      let endLine = Math.min(lines.length, capLines);

      const aroundLine = p.aroundLine != null ? Number(p.aroundLine) : null;
      const radius = p.radius != null ? Number(p.radius) : null;

      if (Number.isFinite(aroundLine) && aroundLine > 0) {
        const r =
          Number.isFinite(radius) && radius > 0 ? Math.min(radius, 200) : 40;
        startLine = Math.max(1, Math.floor(aroundLine - r));
        endLine = Math.min(lines.length, Math.floor(aroundLine + r));
        if (endLine - startLine + 1 > capLines) {
          endLine = Math.min(lines.length, startLine + capLines - 1);
        }
      } else {
        const s = p.startLine != null ? Number(p.startLine) : null;
        const e = p.endLine != null ? Number(p.endLine) : null;
        if (Number.isFinite(s) && s > 0) startLine = Math.floor(s);
        if (Number.isFinite(e) && e > 0) endLine = Math.floor(e);
        if (endLine < startLine) {
          const tmp = startLine;
          startLine = endLine;
          endLine = tmp;
        }
        // Clamp and cap
        startLine = Math.max(1, startLine);
        endLine = Math.min(lines.length, endLine);
        if (endLine - startLine + 1 > capLines) {
          endLine = Math.min(lines.length, startLine + capLines - 1);
        }
      }

      const slice = lines.slice(startLine - 1, endLine);
      // Render with line numbers for grounding
      let snippet = slice
        .map((ln, i) => `${startLine + i}`.padStart(5, " ") + " | " + ln)
        .join("\n");

      // Hard cap characters (avoid blowing up snapshots)
      const hardMaxChars = 32000;
      let truncated = false;
      if (snippet.length > hardMaxChars) {
        snippet = snippet.slice(0, hardMaxChars) + "\n... (truncated)";
        truncated = true;
      }

      push(
        `read_snippet: ${relRaw} L${startLine}-L${endLine}${
          truncated ? " (truncated)" : ""
        }`
      );

      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: {
          path: rel,
          startLine,
          endLine,
          totalLines: lines.length,
          truncated,
          snippet,
        },
      };
    }

    // ---------------- write_file --------
    if (type === "write_file") {
      const target = safeResolve(p.path);
      const content = String(p.content ?? "");
      ensureDirForFile(target);

      const before = fs.existsSync(target)
        ? fs.readFileSync(target, "utf8")
        : "";
      if (before === content) {
        throw new Error(
          `write_file: no changes (content identical) for ${p.path}`
        );
      }

      let backup = null;
      if (fs.existsSync(target)) backup = makeBackup(actionId, target);

      fs.writeFileSync(target, content, "utf8");
      push(`write_file: wrote ${p.path}`);

      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: { path: target, backup, changed: true },
      };
    }

    // ---------------- apply_patch --------
    if (type === "apply_patch") {
      const target = safeResolve(p.path);
      const edits = Array.isArray(p.edits) ? p.edits : [];
      if (!edits.length)
        throw new Error("apply_patch requires payload.edits[]");

      const before = fs.existsSync(target)
        ? fs.readFileSync(target, "utf8")
        : "";
      if (!before)
        throw new Error(`apply_patch: file missing or empty: ${p.path}`);

      const backup = makeBackup(actionId, target);
      let text = before;

      const perEdit = [];
      let anyMatched = false;
      let anyChanged = false;

      for (let i = 0; i < edits.length; i++) {
        const e = edits[i] || {};
        const find = String(e.find ?? "");
        const replace = String(e.replace ?? "");
        const mode = String(e.mode || "once");

        const r = applyPatchOnce(text, find, replace, mode);
        perEdit.push({
          index: i,
          mode,
          matched: r.matched,
          changed: r.changed,
          findLen: find.length,
          replaceLen: replace.length,
        });

        if (r.matched) anyMatched = true;
        if (r.changed) anyChanged = true;
        text = r.out;
      }

      // Enforce no silent success
      if (!anyMatched) {
        restoreBackup(target, backup);
        throw new Error(`apply_patch: no matches in ${p.path}`);
      }
      if (!anyChanged || text === before) {
        restoreBackup(target, backup);
        throw new Error(`apply_patch: no effective change in ${p.path}`);
      }

      fs.writeFileSync(target, text, "utf8");
      push(`apply_patch: wrote ${p.path}`);

      const summary = {
        path: p.path,
        edits: perEdit.length,
        anyMatched,
        anyChanged,
        bytesBefore: before.length,
        bytesAfter: text.length,
      };

      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: {
          path: target,
          backup,
          changed: true,
          perEdit,
          summary,
        },
      };
    }

    // ---------------- bundle ----------------
    if (type === "bundle") {
      const steps = coerceBundleSteps(p);
      if (!steps.length)
        throw new Error(
          "bundle requires payload.steps[] (or payload.actions[])"
        );

      const results = [];
      let restartRequested = false;
      let offRequested = false;

      push(`bundle: ${steps.length} step(s)`);

      for (let i = 0; i < steps.length; i++) {
        const sub = steps[i] || {};
        const subType = String(sub.type || "");
        const subPayload = sub.payload || {};

        if (!subType) throw new Error(`bundle: step[${i}] missing type`);

        push(`bundle: step[${i}] type=${subType}`);

        const r = await executeAction(
          {
            id: `${actionId}_step_${i}`,
            type: subType,
            payload: subPayload,
          },
          _depth + 1
        );

        results.push({
          index: i,
          type: subType,
          ok: r.ok,
          tookMs: r.tookMs,
          log: r.log,
          result: r.result,
          error: r.error,
        });

        if (subType === "restart_piper" && r.ok) restartRequested = true;
        if (subType === "shutdown_piper" && r.ok) offRequested = true;

        // If a step fails, stop the bundle.
        if (!r.ok) {
          throw Object.assign(new Error(`bundle: step[${i}] failed`), {
            result: results,
          });
        }
      }

      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: { results, restartRequested, offRequested },
      };
    }

    throw new Error(`Unknown action type: ${type}`);
  } catch (e) {
    const msg = String(e?.message || e);
    push(`Error: ${msg}`);

    const extra = e?.result ? { commandResult: e.result } : undefined;

    return {
      ok: false,
      tookMs: Date.now() - startedAt,
      log,
      error: msg,
      ...(extra || {}),
    };
  }
}
