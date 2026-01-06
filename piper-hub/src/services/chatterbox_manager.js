import { spawn } from "child_process";
import http from "http";

let proc = null;
let starting = null;
let startedByUs = false;

const HOST = process.env.CHATTERBOX_HOST || "127.0.0.1";
const PORT = Number(process.env.CHATTERBOX_PORT || "4123");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: buf }));
    });
    req.on("error", reject);
  });
}

async function isHealthy() {
  try {
    const r = await httpGet(`http://${HOST}:${PORT}/health`);
    if (r.status !== 200) return false;
    const j = JSON.parse(r.body || "{}");
    return Boolean(j.ok) || String(j.status || "").toLowerCase() === "ok" || Boolean(j.device);
  } catch {
    return false;
  }
}

function buildStartCommand() {
  // If user provided explicit command, use it.
  if (process.env.CHATTERBOX_START_CMD) {
    const parts = String(process.env.CHATTERBOX_START_CMD)
      .split(" ")
      .filter(Boolean);
    return { cmd: parts[0], args: parts.slice(1) };
  }

  // Default: conda run -n <env> python tools\chatterbox_server.py
  const envName = process.env.CHATTERBOX_CONDA_ENV || "chatterbox";
  return {
    cmd: "conda",
    args: ["run", "-n", envName, "python", "tools\\chatterbox_server.py"],
  };
}

/**
 * Ensure Chatterbox is running. If it's already healthy on HOST:PORT, we "adopt" it
 * and do not spawn a second copy (prevents port-binding failures).
 */
export async function ensureChatterboxProcess() {
  if (await isHealthy()) return { ok: true, adopted: true };

  if (starting) return starting;

  starting = (async () => {
    if (await isHealthy()) return { ok: true, adopted: true };

    if (proc && proc.exitCode != null) proc = null;

    const { cmd, args } = buildStartCommand();
    console.log("[chatterbox] starting process…", { cmd, args });

    startedByUs = true;
    proc = spawn(cmd, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    proc.stdout.on("data", (d) => process.stdout.write("[chatterbox] " + String(d)));
    proc.stderr.on("data", (d) => process.stdout.write("[chatterbox] " + String(d)));

    proc.on("exit", (code, signal) => {
      console.log("[chatterbox] exited", { code, signal });
      proc = null;
      startedByUs = false;
    });

    // Wait up to ~20s for health
    for (let i = 0; i < 40; i++) {
      if (await isHealthy()) return { ok: true, adopted: false };
      await sleep(500);
    }
    return { ok: false, adopted: false, error: "Chatterbox did not become healthy in time" };
  })();

  const result = await starting;
  starting = null;
  return result;
}

/**
 * Back-compat for existing imports.
 */
export async function startChatterboxProcess() {
  return ensureChatterboxProcess();
}

function taskkillTree(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    let out = "";
    let err = "";
    killer.stdout.on("data", (d) => (out += String(d)));
    killer.stderr.on("data", (d) => (err += String(d)));
    killer.on("close", (code) => resolve({ code, out, err }));
  });
}

/**
 * Stop Chatterbox if we started it. If we adopted an already-running Chatterbox,
 * we do NOT kill it (avoid nuking user-run servers).
 */
export async function stopChatterboxProcess() {
  if (!proc) return { ok: true, stopped: false, reason: "no-child-proc" };
  if (!startedByUs) return { ok: true, stopped: false, reason: "adopted-not-owned" };

  const pid = proc.pid;
  try {
    const r = await taskkillTree(pid);
    console.log("[chatterbox] taskkill", { pid, code: r.code });
  } catch {}

  proc = null;
  startedByUs = false;
  return { ok: true, stopped: true };
}
