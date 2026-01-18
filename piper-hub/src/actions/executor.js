// src/actions/executor.js
// Windows-first executor for approval-gated actions.
// Key goals:
// - Never crash on spawn errors
// - Support repo/known: edits via safeResolve (apply_patch/write_file/mkdir)
// - Keep user-home writes gated (write_text_file)
// - Provide rollback info (backup path) for file-mutating actions

import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";

import { safeResolve, ensureDirForFile, readTextIfExists } from "../utils/fsx.js";

const _executing = new Set();
const _executed = new Set();

function isWindows() {
  return process.platform === "win32";
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}

function loadAllowlist() {
  const p = path.resolve(process.cwd(), "data", "apps.json");
  const obj = readJson(p);
  const out = {};
  for (const [appId, v] of Object.entries(obj || {})) {
    if (typeof v === "string") out[appId] = { path: v, args: [] };
    else if (v && typeof v === "object" && typeof v.path === "string") {
      out[appId] = { path: v.path, args: Array.isArray(v.args) ? v.args : [] };
    }
  }
  return out;
}

function expandEnvVarsWindows(p) {
  const s = String(p || "");
  return s.replace(/%([^%]+)%/g, (_, name) => {
    const key = String(name || "").trim();
    const val = process.env[key];
    return val != null ? String(val) : `%${key}%`;
  });
}

function normalizeCmdPath(cmd) {
  let c = String(cmd || "").trim();
  if (!c) return c;
  if (isWindows()) c = expandEnvVarsWindows(c);
  if (
    (c.startsWith('"') && c.endsWith('"')) ||
    (c.startsWith("'") && c.endsWith("'"))
  )
    c = c.slice(1, -1);
  return c;
}

function spawnDetached(cmd, args = [], cwd = process.cwd()) {
  const command = normalizeCmdPath(cmd);
  const argv = Array.isArray(args)
    ? args.map((a) => (isWindows() ? expandEnvVarsWindows(String(a)) : String(a)))
    : [];

  if (isWindows() && /[\\/]/.test(command) && !fs.existsSync(command)) {
    console.log(`[executor] spawnDetached missing path: "${command}"`);
    return { ok: false, error: `Executable not found: ${command}` };
  }

  try {
    const child = spawn(command, argv, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", (err) => {
      console.log(
        `[executor] spawnDetached error cmd="${command}" code="${err?.code || ""}" msg="${err?.message || err}"`
      );
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    console.log(
      `[executor] spawnDetached threw cmd="${command}" msg="${err?.message || err}"`
    );
    return { ok: false, error: String(err?.message || err) };
  }
}

function shellStart(target) {
  return spawnDetached("cmd.exe", ["/c", "start", '""', target]);
}

function ensureUnderUserProfile(pth) {
  const up = process.env.USERPROFILE || os.homedir();
  const abs = path.resolve(pth);
  const root = path.resolve(up);
  return abs.toLowerCase().startsWith(root.toLowerCase());
}

function backupsDir() {
  return path.resolve(process.cwd(), "data", "backups");
}

function ensureBackupsDir() {
  fs.mkdirSync(backupsDir(), { recursive: true });
}

function makeBackupPath(actionId, targetAbs) {
  ensureBackupsDir();
  const base = path.basename(String(targetAbs || "file"));
  const stamp = Date.now().toString(16);
  const safeId = String(actionId || "act")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48);
  return path.join(backupsDir(), `${safeId}_${stamp}_${base}.bak`);
}

function backupIfExists(actionId, targetAbs) {
  try {
    if (!fs.existsSync(targetAbs)) return null;
    const backupAbs = makeBackupPath(actionId, targetAbs);
    fs.copyFileSync(targetAbs, backupAbs);
    return backupAbs;
  } catch (e) {
    console.log(`[executor] backup failed id="${actionId}":`, e?.message || e);
    return null;
  }
}

function applyEditsToText(oldText, edits) {
  let out = String(oldText ?? "");
  const arr = Array.isArray(edits) ? edits : [];

  for (const e of arr) {
    const find = String(e?.find ?? "");
    const replace = String(e?.replace ?? "");
    const mode =
      e?.mode === "all" ? "all" : e?.mode === "append" ? "append" : "once";

    if (mode === "append") {
      out = out + replace;
      continue;
    }

    if (!find) continue;

    if (mode === "all") {
      out = out.split(find).join(replace);
      continue;
    }

    const idx = out.indexOf(find);
    if (idx !== -1) {
      out = out.slice(0, idx) + replace + out.slice(idx + find.length);
    }
  }

  return out;
}

async function executeCore(action, { dryRun = false } = {}) {
  const id = String(action?.id || "");
  const type = String(action?.type || "");
  const payload = action?.payload || {};

  if (!id) return { ok: false, error: "Missing action.id" };

  if (_executed.has(id)) {
    console.log(`[executor] skip (already executed) id="${id}"`);
    return { ok: true, skipped: true, reason: "already_executed" };
  }
  if (_executing.has(id)) {
    console.log(`[executor] skip (already executing) id="${id}"`);
    return { ok: true, skipped: true, reason: "already_executing" };
  }

  _executing.add(id);
  console.log(`[executor] execute type="${type}" id="${id}"`);

  try {
    if (!isWindows()) return { ok: false, error: "Windows-only executor (win32)." };

    if (dryRun) {
      console.log(`[executor] dryRun=true type="${type}" id="${id}" payload=`, payload);
      _executed.add(id);
      return { ok: true, dryRun: true };
    }

    // mark executed early to avoid double-run if caller duplicates
    _executed.add(id);

    if (type === "launch_app") {
      const appId = String(payload?.appId || "").trim();
      if (!appId) return { ok: false, error: "launch_app missing payload.appId" };
      const allow = loadAllowlist();
      const entry = allow[appId];
      if (!entry?.path)
        return { ok: false, error: `App "${appId}" is not allowlisted (data/apps.json).` };
      console.log(
        `[executor] launch_app appId="${appId}" path="${entry.path}" args=${JSON.stringify(entry.args || [])}`
      );
      const r = spawnDetached(entry.path, entry.args || []);
      if (!r.ok) return r;
      return { ok: true };
    }

    if (type === "open_path") {
      const pth = String(payload?.path || "").trim();
      if (!pth) return { ok: false, error: "open_path missing payload.path" };
      console.log(`[executor] open_path path="${pth}"`);
      const r = spawnDetached("explorer.exe", [pth]);
      if (!r.ok) return r;
      return { ok: true };
    }

    if (type === "open_url") {
      const url = String(payload?.url || "").trim();
      if (!url) return { ok: false, error: "open_url missing payload.url" };
      if (!/^https?:\/\//i.test(url))
        return { ok: false, error: "open_url requires http/https URL" };
      console.log(`[executor] open_url url="${url}"`);
      shellStart(url);
      return { ok: true };
    }

    if (type === "write_text_file") {
      const pth = String(payload?.path || "").trim();
      const content = String(payload?.content ?? "");
      if (!pth) return { ok: false, error: "write_text_file missing payload.path" };
      if (!ensureUnderUserProfile(pth))
        return { ok: false, error: "Refusing to write outside USERPROFILE." };
      fs.mkdirSync(path.dirname(pth), { recursive: true });
      fs.writeFileSync(pth, content, "utf-8");
      console.log(`[executor] write_text_file path="${pth}" chars=${content.length}`);
      return { ok: true, result: { path: pth } };
    }

    if (type === "allowlist_app") {
      const appId = String(payload?.appId || "").trim();
      const exePath = String(payload?.path || "").trim();
      const args = Array.isArray(payload?.args) ? payload.args : [];
      if (!appId || !exePath)
        return { ok: false, error: "allowlist_app requires payload.appId and payload.path" };
      const p = path.resolve(process.cwd(), "data", "apps.json");
      let obj = {};
      try {
        obj = readJson(p);
      } catch {
        obj = {};
      }
      obj[appId] = { path: exePath, args };
      writeJson(p, obj);
      console.log(`[executor] allowlist_app appId="${appId}" path="${exePath}"`);
      return { ok: true };
    }

    // Repo/known: file writes (approval-gated)
    if (type === "write_file") {
      const rel = String(payload?.path || "").trim();
      const content = String(payload?.content ?? "");
      if (!rel) return { ok: false, error: "write_file missing payload.path" };

      const abs = safeResolve(rel);
      ensureDirForFile(abs);
      const backup = backupIfExists(id, abs);
      fs.writeFileSync(abs, content, "utf-8");

      console.log(`[executor] write_file rel="${rel}" bytes=${content.length}`);
      return { ok: true, result: { path: rel, backup } };
    }

    if (type === "apply_patch") {
      const rel = String(payload?.path || "").trim();
      const edits = Array.isArray(payload?.edits) ? payload.edits : [];
      if (!rel) return { ok: false, error: "apply_patch missing payload.path" };

      const abs = safeResolve(rel);
      const oldText = readTextIfExists(abs, "");
      const nextText = applyEditsToText(oldText, edits);

      ensureDirForFile(abs);
      const backup = backupIfExists(id, abs);
      fs.writeFileSync(abs, nextText, "utf-8");

      console.log(
        `[executor] apply_patch rel="${rel}" edits=${edits.length} oldBytes=${oldText.length} newBytes=${nextText.length}`
      );

      return {
        ok: true,
        result: { path: rel, backup, edits: edits.length, oldBytes: oldText.length, newBytes: nextText.length },
      };
    }

    if (type === "mkdir") {
      const rel = String(payload?.path || "").trim();
      if (!rel) return { ok: false, error: "mkdir missing payload.path" };
      const abs = safeResolve(rel);
      fs.mkdirSync(abs, { recursive: true });
      console.log(`[executor] mkdir rel="${rel}"`);
      return { ok: true, result: { path: rel } };
    }

    if (type === "run_cmd") {
      // Safety: this project already uses run_cmd as an approval-gated inspection tool.
      // Keep it simple: spawn cmd.exe /c <cmd> and capture output to meta result.
      const cmd = String(payload?.cmd || "").trim();
      const cwd = payload?.cwd ? String(payload.cwd) : process.cwd();
      if (!cmd) return { ok: false, error: "run_cmd missing payload.cmd" };

      return await new Promise((resolve) => {
        const child = spawn("cmd.exe", ["/c", cmd], { cwd, windowsHide: true });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += String(d)));
        child.stderr.on("data", (d) => (err += String(d)));
        child.on("error", (e) =>
          resolve({ ok: false, error: String(e?.message || e), result: { stdout: out, stderr: err } })
        );
        child.on("close", (code) => {
          resolve({
            ok: code === 0,
            result: { stdout: out, stderr: err, code },
            error: code === 0 ? undefined : `Command exited with code ${code}`,
          });
        });
      });
    }

    if (type === "bundle") {
      const steps = Array.isArray(payload?.steps)
        ? payload.steps
        : Array.isArray(payload?.actions)
        ? payload.actions
        : [];

      const results = [];
      for (const step of steps) {
        if (!step) continue;
        const sub = {
          id: `${id}::${String(step?.type || "step")}`,
          type: step?.type,
          payload: step?.payload || {},
        };
        // IMPORTANT: bundled steps are always executed (no nested dryRun here)
        const r = await executeCore(sub, { dryRun: false });
        results.push(r);
        if (!r.ok) {
          return { ok: false, error: `bundle step failed: ${String(sub.type)}`, result: { results } };
        }
      }
      return { ok: true, result: { results } };
    }

    return { ok: false, error: `Unknown action type "${type}"` };
  } catch (e) {
    console.log(`[executor] ERROR type="${type}" id="${id}":`, e);
    return { ok: false, error: String(e?.message || e) };
  } finally {
    _executing.delete(id);
  }
}

export async function executeAction(action, opts = {}) {
  return executeCore(action, opts);
}

export function restoreBackup(backupPath, targetRel) {
  const backup = String(backupPath || "").trim();
  const target = String(targetRel || "").trim();
  if (!backup || !target) throw new Error("Missing backup or target");

  const backupAbs = path.isAbsolute(backup) ? backup : path.resolve(backupsDir(), backup);
  const targetAbs = safeResolve(target);

  if (!fs.existsSync(backupAbs)) throw new Error("Backup file not found");

  ensureDirForFile(targetAbs);
  fs.copyFileSync(backupAbs, targetAbs);

  return { ok: true, restoredTo: targetAbs, from: backupAbs };
}
