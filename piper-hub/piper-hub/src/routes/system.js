import { Router } from "express";

export function systemRoutes({ port }) {
  const r = Router();
  r.get("/ping", (req, res) =>
    res.json({
      ok: true,
      port,
      pid: process.pid,
      time: new Date().toISOString(),
    })
  );
  return r;
}
