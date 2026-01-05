// src/actions/executor.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { ROOT } from "../config/paths.js";
import {
  safeResolve,
  ensureDirForFile,
  readTextIfExists,
} from "../utils/fsx.js";

const exec = promisify(execCb);

function nowId() {
  return crypto.randomBytes(6).toString("hex") + "_" + Date.now().toString(16);
}

function backupDir() {
  const dir = path.join(ROOT, "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeForFilename(s) {
  return String(s || "")
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replaceAll(":", "_")
    .replaceAll("..", "_");
}

function writeBackupForTarget(relTarget, oldContent) {
  const dir = backupDir();
  const name = `${Date.now()}_${nowId()}_${sanitizeForFilename(relTarget)}.bak`;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, String(oldContent ?? ""), "utf8");
  return abs;
}

function applyPatchInMemory(before, edits) {
  let out = String(before ?? "");
  let changedAny = false;
  const perEdit = [];

  for (let i = 0; i < (edits || []).length; i++) {
    const e = edits[i] || {};
    const find = String(e?.find ?? "");
    const replace = String(e?.replace ?? "");
    const mode = e?.mode === "all" ? "all" : "once";

    if (!find) {
      perEdit.push({
        index: i,
        matched: false,
        changed: false,
        mode,
        note: "missing find",
      });
      continue;
    }

    if (mode === "all") {
      const matched = out.includes(find);
      const next = matched ? out.split(find).join(replace) : out;
      const changed = next !== out;
      if (changed) changedAny = true;
      out = next;
      perEdit.push({ index: i, matched, changed, mode });
    } else {
      const idx = out.indexOf(find);
      const matched = idx !== -1;
      if (matched) {
        out = out.slice(0, idx) + replace + out.slice(idx + find.length);
        changedAny = true;
        perEdit.push({ index: i, matched: true, changed: true, mode });
      } else {
        perEdit.push({ index: i, matched: false, changed: false, mode });
      }
    }
  }

  return { out, changedAny, perEdit };
}

export function restoreBackup(backupAbsPath, targetRelPath) {
  const backup = String(backupAbsPath || "");
  const targetRel = String(targetRelPath || "");
  if (!backup || !targetRel) throw new Error("restoreBackup missing args");
  if (!fs.existsSync(backup)) throw new Error(`Backup not found: ${backup}`);

  const targetAbs = safeResolve(targetRel);
  ensureDirForFile(targetAbs);

  const data = fs.readFileSync(backup);
  fs.writeFileSync(targetAbs, data);

  console.log(
    `[executor] rollback restored backup -> target rel="${targetRel}" abs="${targetAbs}"`
  );
}

async function execCommand(cmd, timeoutMs = 30000) {
  const c = String(cmd || "").trim();
  if (!c) throw new Error("Missing cmd");
  const { stdout, stderr } = await exec(c, {
    timeout: timeoutMs,
    windowsHide: true,
    cwd: ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

function setHtmlTitleInText(html, title) {
  const t = String(title ?? "");
  const re = /<title>[\s\S]*?<\/title>/i;
  if (!re.test(html)) {
    // If no title tag exists, add one (best-effort)
    // Insert after <head> if present, otherwise at the top.
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head[^>]*>/i, (m) => `${m}\n  <title>${t}</title>`);
    }
    return `<title>${t}</title>\n` + html;
  }
  return html.replace(re, `<title>${t}</title>`);
}

export async function executeAction(action) {
  const type = String(action?.type || "");
  const payload = action?.payload || {};

  try {
    console.log(`[executor] execute type="${type}" id="${action?.id || ""}"`);

    // ---- set_html_title ----
    if (type === "set_html_title") {
      const rel = String(payload.path || "");
      const abs = safeResolve(rel);
      const desired = String(payload.title ?? "");

      const oldText = readTextIfExists(abs, "");
      const newText = setHtmlTitleInText(oldText, desired);

      if (newText === oldText) {
        console.log(`[executor] set_html_title no-op rel="${rel}"`);
        return {
          ok: true,
          result: { type, path: rel, abs, note: "No changes needed." },
        };
      }

      const backup = writeBackupForTarget(rel, oldText);

      ensureDirForFile(abs);
      fs.writeFileSync(abs, newText, "utf8");

      console.log(
        `[executor] set_html_title ok rel="${rel}" abs="${abs}" title="${desired}"`
      );
      return {
        ok: true,
        result: { type, path: rel, abs, backup, title: desired },
      };
    }

    // ---- write_file ----
    if (type === "write_file") {
      const rel = String(payload.path || "");
      const abs = safeResolve(rel);

      const oldText = readTextIfExists(abs, "");
      const newText = String(payload.content ?? "");

      const backup = writeBackupForTarget(rel, oldText);

      ensureDirForFile(abs);
      fs.writeFileSync(abs, newText, "utf8");

      console.log(
        `[executor] write_file ok rel="${rel}" abs="${abs}" bytes=${Buffer.byteLength(
          newText,
          "utf8"
        )}`
      );
      return {
        ok: true,
        result: {
          type,
          path: rel,
          abs,
          backup,
          bytes: Buffer.byteLength(newText, "utf8"),
        },
      };
    }

    // ---- apply_patch ----
    if (type === "apply_patch") {
      const rel = String(payload.path || "");
      const abs = safeResolve(rel);

      const oldText = readTextIfExists(abs, "");
      const edits = Array.isArray(payload.edits) ? payload.edits : [];

      const mem = applyPatchInMemory(oldText, edits);
      const newText = mem.out;

      const anyUnmatched = (mem.perEdit || []).some((e) => e.matched === false);
      if (!mem.changedAny || anyUnmatched) {
        console.log(
          `[executor] apply_patch FAILED rel="${rel}" changedAny=${mem.changedAny} anyUnmatched=${anyUnmatched}`
        );
        return {
          ok: false,
          result: {
            type,
            path: rel,
            abs,
            changedAny: mem.changedAny,
            anyUnmatched,
            perEdit: mem.perEdit,
            error:
              "Patch did not fully apply. One or more 'find' anchors failed to match.",
          },
        };
      }

      const backup = writeBackupForTarget(rel, oldText);

      ensureDirForFile(abs);
      fs.writeFileSync(abs, newText, "utf8");

      console.log(
        `[executor] apply_patch ok rel="${rel}" abs="${abs}" edits=${edits.length}`
      );
      return {
        ok: true,
        result: {
          type,
          path: rel,
          abs,
          backup,
          edits: edits.length,
          perEdit: mem.perEdit,
        },
      };
    }

    // ---- mkdir ----
    if (type === "mkdir") {
      const rel = String(payload.path || "");
      const abs = safeResolve(rel);

      fs.mkdirSync(abs, { recursive: true });

      console.log(`[executor] mkdir ok rel="${rel}" abs="${abs}"`);
      return { ok: true, result: { type, path: rel, abs } };
    }

    // ---- run_cmd ----
    if (type === "run_cmd") {
      const cmd = String(payload.cmd || "");
      const timeoutMs = Number(payload.timeoutMs || 30000);

      const out = await execCommand(cmd, timeoutMs);
      console.log(`[executor] run_cmd ok cmd="${cmd.slice(0, 120)}"`);
      return { ok: true, result: { type, cmd, ok: true, ...out } };
    }

    // ---- restart / shutdown ----
    if (type === "restart_piper") {
      console.log(`[executor] restart requested`);
      return { ok: true, result: { type, restartRequested: true } };
    }
    if (type === "shutdown_piper") {
      console.log(`[executor] shutdown requested`);
      return { ok: true, result: { type, offRequested: true } };
    }

    // ---- bundle ----
    if (type === "bundle") {
      const steps = Array.isArray(payload.steps)
        ? payload.steps
        : Array.isArray(payload.actions)
        ? payload.actions
        : [];

      const results = [];
      let restartRequested = false;
      let offRequested = false;

      for (const step of steps) {
        const sub = {
          id: action?.id,
          type: step?.type,
          payload: step?.payload || {},
        };
        const r = await executeAction(sub);
        results.push({ step: sub.type, ok: r.ok, result: r.result });

        if (!r.ok) {
          console.log(`[executor] bundle failed at step type="${sub.type}"`);
          return { ok: false, result: { type, results } };
        }

        if (r?.result?.restartRequested) restartRequested = true;
        if (r?.result?.offRequested) offRequested = true;
      }

      return {
        ok: true,
        result: { type, results, restartRequested, offRequested },
      };
    }

    return {
      ok: false,
      result: { type, error: `Unknown action type: ${type}` },
    };
  } catch (e) {
    console.log(`[executor] error type="${type}": ${String(e)}`);
    return { ok: false, result: { type, error: String(e) } };
  }
}
