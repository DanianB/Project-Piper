// src/routes/blocks.js
import { Router } from "express";
import { buildSnapshot } from "../planner/snapshot.js";

export function blocksRoutes() {
  const r = Router();

  // List blocks (useful for debugging grounded edits)
  // /blocks?file=public/styles.css
  r.get("/blocks", (req, res) => {
    const file = String(req.query.file || "").trim();
    const snap = buildSnapshot();

    let blocks = snap.blocks;
    if (file) blocks = blocks.filter((b) => b.file === file);

    res.json({
      ok: true,
      count: blocks.length,
      blocks: blocks.map((b) => ({
        file: b.file,
        blockId: b.blockId,
        kind: b.kind,
        label: b.label,
        startLine: b.startLine,
        endLine: b.endLine,
        snippet: String(b.text || "").slice(0, 220),
      })),
    });
  });

  return r;
}
