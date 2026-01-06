import express from "express";
import path from "path";
import fs from "fs";
import { DEFAULT_PORT, LIMITS, OFF_EXIT_CODE } from "./config/constants.js";
import { ROOT, OFF_FLAG_PATH } from "./config/paths.js";
import { systemRoutes } from "./routes/system.js";
import { chatRoutes } from "./routes/chat.js";
import { voiceRoutes } from "./routes/voice.js";
import { actionRoutes } from "./routes/actions.js";
import { deviceRoutes } from "./routes/devices.js";
import { blocksRoutes } from "./routes/blocks.js";
import { buildCodebaseIndex } from "./indexer/indexer.js";
import { startChatterboxProcess, stopChatterboxProcess } from "./services/chatterbox_manager.js";

const app = express();
const PORT = DEFAULT_PORT;

app.use(express.json({ limit: LIMITS.jsonBody }));
app.use(express.static(path.join(ROOT, "public")));
app.use(blocksRoutes());
app.use(systemRoutes({ port: PORT }));
app.use(chatRoutes());
app.use(voiceRoutes());
app.use(actionRoutes());
app.use(deviceRoutes());

let server;
const sockets = new Set();
let shuttingDown = false;

function destroySockets() {
  for (const s of sockets) {
    try { s.destroy(); } catch {}
  }
}

async function closeServer() {
  destroySockets();
  if (!server) return;
  await new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

async function gracefulShutdown(reason, exitCode = 0, writeOffFlag = false) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    console.log("[server] shutdown", { reason, exitCode, writeOffFlag });

    try {
      await stopChatterboxProcess();
    } catch (e) {
      console.warn("[server] stopChatterboxProcess failed:", e?.message || e);
    }

    await closeServer();

    if (writeOffFlag) {
      try {
        fs.writeFileSync(OFF_FLAG_PATH, `OFF ${new Date().toISOString()}\n`, "utf8");
      } catch {}
    }
  } finally {
    process.exit(exitCode);
  }
}

// /shutdown: closes server + exits 99 (OFF) so supervisor stops
app.post("/shutdown", (req, res) => {
  res.json({ ok: true });

  setTimeout(() => {
    gracefulShutdown("api:/shutdown", OFF_EXIT_CODE, true).catch(() => process.exit(OFF_EXIT_CODE));
  }, 150).unref();
});

// Build codebase index at startup (best-effort)
try {
  const result = buildCodebaseIndex({
    rootDir: ROOT,
    outFile: "data/index.json",
  });
  console.log("🧭 Codebase indexed:", result.counts);
} catch (e) {
  console.warn("⚠️ Codebase index failed:", e?.message || e);
}

// Optional: auto-start local Chatterbox API server
const AUTOSTART_CHATTERBOX =
  String(process.env.CHATTERBOX_AUTOSTART || "").toLowerCase() === "1" ||
  String(process.env.CHATTERBOX_AUTOSTART || "").toLowerCase() === "true";

if (AUTOSTART_CHATTERBOX) {
  startChatterboxProcess().catch((e) => {
    console.warn("[chatterbox] autostart failed:", e?.message || e);
  });
}

server = app.listen(PORT, () =>
  console.log(`✅ Piper Hub listening on http://localhost:${PORT}`)
);

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

// Ensure chatterbox process is closed when Piper exits (Ctrl+C, terminal close, etc.)
const _exitSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const sig of _exitSignals) {
  process.on(sig, () => {
    gracefulShutdown(`signal:${sig}`, 0, false).catch(() => process.exit(0));
  });
}

// Last-resort hook (may not run on hard kills)
process.on("exit", () => {
  try { stopChatterboxProcess().catch(() => {}); } catch {}
});
