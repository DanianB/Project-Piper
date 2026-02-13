import express from "express";
import path from "path";
import fs from "fs";
import { DEFAULT_PORT, LIMITS, OFF_EXIT_CODE } from "./config/constants.js";
import { ROOT, OFF_FLAG_PATH } from "./config/paths.js";
import { systemRoutes } from "./routes/system.js";
import { chatRoutes } from "./routes/chat.js";
import { planRoutes } from "./routes/plan.js";
import { voiceRoutes } from "./routes/voice.js";
import { actionRoutes } from "./routes/actions.js";
import { runlogRoutes } from "./routes/runlog.js";
import { toolsRoutes } from "./routes/tools.js";
import { deviceRoutes } from "./routes/devices.js";
import { blocksRoutes } from "./routes/blocks.js";
import { buildCodebaseIndex } from "./indexer/indexer.js";

const app = express();
const PORT = DEFAULT_PORT;

app.use(express.json({ limit: LIMITS.jsonBody }));
app.use(express.static(path.join(ROOT, "public")));
app.use(blocksRoutes());
app.use(systemRoutes({ port: PORT }));
app.use(chatRoutes());
app.use(voiceRoutes());
app.use(actionRoutes());
app.use(runlogRoutes());
app.use(toolsRoutes());
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
    } catch (e) {
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

// Codebase indexing can be expensive on large repos. Run after startup and allow disabling.
const disableIndex = process.env.PIPER_DISABLE_INDEX === "1";
if (!disableIndex) {
  setTimeout(() => {
    try {
      const result = buildCodebaseIndex({
        rootDir: ROOT,
        outFile: "data/index.json",
      });
      console.log("🧭 Codebase indexed:", result.counts);
    } catch (e) {
      console.warn("⚠️ Codebase index failed:", e?.message || e);
    }
  }, 50).unref();
} else {
  console.log("🧭 Codebase index disabled (PIPER_DISABLE_INDEX=1)");
}

server = app.listen(PORT, () =>
  console.log(`✅ Piper Hub listening on http://localhost:${PORT}`)
);

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

const _exitSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const sig of _exitSignals) {
  process.on(sig, () => {
    gracefulShutdown(`signal:${sig}`, 0, false).catch(() => process.exit(0));
  });
}

// Last-resort hook (may not run on hard kills)
process.on("exit", () => {
});
