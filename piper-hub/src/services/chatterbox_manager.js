// src/services/chatterbox_manager.js
import { spawn } from "child_process";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

let proc = null;
let starting = null;
let startedByUs = false;
let prewarmed = false;

const HOST = process.env.CHATTERBOX_HOST || "127.0.0.1";
const PORT = Number(process.env.CHATTERBOX_PORT || "4123");

// repo root: <root>/src/services/chatterbox_manager.js -> go up 2
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// absolute script path
const CHATTERBOX_SCRIPT_ABS = path.join(
  PROJECT_ROOT,
  "tools",
  "chatterbox_server.py"
);

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

function httpPostJson(url, payload) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const data = Buffer.from(JSON.stringify(payload || {}));
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + (u.search || ""),
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": data.length,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += String(d)));
          res.on("end", () => resolve({ status: res.statusCode || 0, body }));
        }
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function maybePrewarm() {
  if (prewarmed) return;
  if (String(process.env.CHATTERBOX_PREWARM || "").toLowerCase() !== "1")
    return;

  // Only prewarm if healthy; keep it lightweight.
  const endpoint = `http://${HOST}:${PORT}/audio/speech`;
  try {
    const r = await httpPostJson(endpoint, {
      input: "warm up",
      voice: "default",
      max_new_tokens: 48,
    });
    if (r.status >= 200 && r.status < 300) {
      prewarmed = true;
      console.log("[chatterbox] prewarm ok");
    } else {
      console.log("[chatterbox] prewarm non-2xx", {
        status: r.status,
        body: r.body?.slice?.(0, 200),
      });
    }
  } catch (e) {
    console.log("[chatterbox] prewarm failed", {
      err: String(e?.message || e),
    });
  }
}

async function isHealthy() {
  try {
    const r = await httpGet(`http://${HOST}:${PORT}/health`);
    if (r.status !== 200) return false;
    const j = JSON.parse(r.body || "{}");
    return (
      Boolean(j.ok) ||
      String(j.status || "").toLowerCase() === "ok" ||
      Boolean(j.device)
    );
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
    return { cmd: parts[0], args: parts.slice(1), cwd: PROJECT_ROOT };
  }

  // Default: conda run -n <env> python <ABS_PATH_TO_tools/chatterbox_server.py>
  const envName = process.env.CHATTERBOX_CONDA_ENV || "chatterbox";
  return {
    cmd: "conda",
    args: ["run", "-n", envName, "python", CHATTERBOX_SCRIPT_ABS],
    cwd: PROJECT_ROOT,
  };
}

/**
 * Ensure Chatterbox is running. If it's already healthy on HOST:PORT, we "adopt" it
 * and do not spawn a second copy (prevents port-binding failures).
 */
export async function ensureChatterboxProcess() {
  if (await isHealthy()) {
    await maybePrewarm();
    return { ok: true, adopted: true };
  }

  if (starting) return starting;

  starting = (async () => {
    try {
    if (await isHealthy()) {
      await maybePrewarm();
      return { ok: true, adopted: true };
    }

    if (proc && proc.exitCode != null) proc = null;

    const { cmd, args, cwd } = buildStartCommand();
    console.log("[chatterbox] starting process…", {
      cmd,
      args,
      cwd,
      script: CHATTERBOX_SCRIPT_ABS,
    });

    startedByUs = true;
    proc = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });


    let startErr = null;
    proc.on("error", (err) => {
      startErr = err;
      console.log("[chatterbox] spawn error", { message: String(err?.message || err) });
      proc = null;
      startedByUs = false;
    });

    // If spawn fails (e.g. conda not on PATH), bail early instead of crashing Piper.
    // The health loop below will detect startErr and return a clean error.

    proc.stdout.on("data", (d) =>
      process.stdout.write("[chatterbox] " + String(d))
    );
    proc.stderr.on("data", (d) =>
      process.stdout.write("[chatterbox] " + String(d))
    );

    proc.on("exit", (code, signal) => {
      console.log("[chatterbox] exited", { code, signal });
      proc = null;
      startedByUs = false;
    });

    // Wait up to ~20s for health
    for (let i = 0; i < 40; i++) {
      if (startErr) {
        throw new Error(`Chatterbox spawn failed: ${String(startErr.message || startErr)}`);
      }
      if (await isHealthy()) {
        await maybePrewarm();
        return { ok: true, adopted: false };
      }
      await sleep(500);
    }
    return {
      ok: false,
      adopted: false,
      error: "Chatterbox did not become healthy in time",
    };
    } finally {
      starting = null;
    }
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
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
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
  if (!startedByUs)
    return { ok: true, stopped: false, reason: "adopted-not-owned" };

  const pid = proc.pid;
  try {
    const r = await taskkillTree(pid);
    console.log("[chatterbox] taskkill", { pid, code: r.code });
  } catch {}

  proc = null;
  startedByUs = false;
  return { ok: true, stopped: true };
}