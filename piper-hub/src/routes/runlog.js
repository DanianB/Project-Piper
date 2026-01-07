// src/routes/runlog.js
import { Router } from "express";
import { readRunLog } from "../utils/runlog.js";

export function runlogRoutes() {
  const r = Router();

  r.get("/runlog", (req, res) => {
    const limit = Number(req.query.limit || 200);
    const events = readRunLog(limit);
    res.json({ ok: true, events });
  });

  return r;
}
