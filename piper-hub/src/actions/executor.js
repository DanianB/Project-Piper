// src/actions/executor.js
// Phase 3 executor (Windows-only) with approval-gated actions + safe idempotency.
// Expected exports: executeAction, restoreBackup

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

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
    else if (v && typeof v === "object" && typeof v.path === "string")
      out[appId] = { path: v.path, args: Array.isArray(v.args) ? v.args : [] };
  }
  return out;
}

function spawnDetached(cmd, args = [], cwd = process.cwd()) {
  const child = spawn(cmd, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return true;
}

function shellStart(target) {
  return spawnDetached("cmd.exe", ["/c", "start", '""', target]);
}

function ensureUnderUserProfile(pth) {
  const up = process.env.USERPROFILE;
  if (!up) return true; // best-effort
  const abs = path.resolve(pth);
  const root = path.resolve(up);
  return abs.toLowerCase().startsWith(root.toLowerCase());
}

async function executeCore(action, { dryRun = false } = {}) {
  const id = String(action?.id || "");
  const type = String(action?.type || "");
  const payload = action?.payload || {};

  console.log(`[executor] execute type="${type}" id="${id}"`);

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
      if (!entry?.path) return { ok: false, error: `App "${appId}" is not allowlisted (data/apps.json).` };
      console.log(`[executor] launch_app appId="${appId}" path="${entry.path}" args=${JSON.stringify(entry.args || [])}`);
      spawnDetached(entry.path, entry.args || []);
      return { ok: true };
    }

    if (type === "open_path") {
      const pth = String(payload?.path || "").trim();
      if (!pth) return { ok: false, error: "open_path missing payload.path" };
      console.log(`[executor] open_path path="${pth}"`);
      spawnDetached("explorer.exe", [pth]);
      return { ok: true };
    }

    if (type === "open_url") {
      const url = String(payload?.url || "").trim();
      if (!url) return { ok: false, error: "open_url missing payload.url" };
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "open_url requires http/https URL" };
      console.log(`[executor] open_url url="${url}"`);
      shellStart(url);
      return { ok: true };
    }

    if (type === "write_text_file") {
      const pth = String(payload?.path || "").trim();
      const content = String(payload?.content || "");
      if (!pth) return { ok: false, error: "write_text_file missing payload.path" };
      if (!ensureUnderUserProfile(pth)) return { ok: false, error: "Refusing to write outside USERPROFILE." };
      fs.mkdirSync(path.dirname(pth), { recursive: true });
      fs.writeFileSync(pth, content, "utf-8");
      console.log(`[executor] write_text_file path="${pth}" chars=${content.length}`);
      return { ok: true };
    }

    if (type === "allowlist_app") {
      const appId = String(payload?.appId || "").trim();
      const exePath = String(payload?.path || "").trim();
      const args = Array.isArray(payload?.args) ? payload.args : [];
      if (!appId || !exePath) return { ok: false, error: "allowlist_app requires payload.appId and payload.path" };
      const p = path.resolve(process.cwd(), "data", "apps.json");
      let obj = {};
      try { obj = readJson(p); } catch { obj = {}; }
      obj[appId] = { path: exePath, args };
      writeJson(p, obj);
      console.log(`[executor] allowlist_app appId="${appId}" path="${exePath}"`);
      return { ok: true };
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

export async function restoreBackup() {
  return { ok: true, restored: false };
}
