// src/routes/plan.js
import { Router } from "express";
import { getCurrentPlan, setPlanStatus } from "../services/plan/store.js";

export const planRoutes = Router();

planRoutes.get("/current", (req, res) => {
  const sid = String(req.query.sid || "").trim();
  const plan = getCurrentPlan(sid);
  return res.json({ ok: true, plan });
});

planRoutes.post("/approve", (req, res) => {
  const sid = String(req.body?.sid || "").trim();
  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });
  const plan = setPlanStatus(sid, "approved");
  if (!plan) return res.status(404).json({ ok: false, error: "No plan to approve" });
  return res.json({ ok: true, plan });
});

planRoutes.post("/abort", (req, res) => {
  const sid = String(req.body?.sid || "").trim();
  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });
  const plan = setPlanStatus(sid, "aborted");
  if (!plan) return res.status(404).json({ ok: false, error: "No plan to abort" });
  return res.json({ ok: true, plan });
});
