import express from "express";
import path from "path";
import { DEFAULT_PORT, LIMITS, OFF_EXIT_CODE } from "./config/constants.js";
import { ROOT } from "./config/paths.js";
import { systemRoutes } from "./routes/system.js";
import { chatRoutes } from "./routes/chat.js";
import { voiceRoutes } from "./routes/voice.js";
import { actionRoutes } from "./routes/actions.js";
import { deviceRoutes } from "./routes/devices.js";
import { blocksRoutes } from "./routes/blocks.js";
import fs from "fs";
import { OFF_FLAG_PATH } from "./config/paths.js";
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
app.use(deviceRoutes());

// /shutdown: closes server + exits 99 (OFF) so supervisor stops
let server;
const sockets = new Set();

app.post("/shutdown", (req, res) => {
  res.json({ ok: true });

  setTimeout(() => {
    try {
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {}
      }
      server?.close(() => {
        try {
          fs.writeFileSync(
            OFF_FLAG_PATH,
            `OFF ${new Date().toISOString()}\n`,
            "utf8"
          );
        } catch {}
        process.exit(OFF_EXIT_CODE);
      });
    } catch {
      process.exit(OFF_EXIT_CODE);
    }
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

server = app.listen(PORT, () =>
  console.log(`✅ Piper Hub listening on http://localhost:${PORT}`)
);

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
