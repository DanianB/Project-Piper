// src/routes/chat/handler.js
import express from "express";
import { enforcePiper } from "../../services/persona.js";
import { getAffectSnapshot } from "../../services/mind.js";
import { triageNeedsPlanner } from "../../planner/triage.js";
import runPlannerFlow from "./workflows/plannerFlow.js";
import runChatFlow from "./workflows/chatFlow.js";

const router = express.Router();

router.post("/chat", async (req, res) => {
  const sid = req.body?.sid || req.ip;
  const message = String(req.body?.message || "").trim();
  const affect = getAffectSnapshot?.(sid);

  if (!message) {
    return res.json({
      reply: enforcePiper("Say something for me to act on, sir."),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  const triage = await triageNeedsPlanner({
    message,
    lastIntent: req.body?.lastIntent,
  });

  if (triage.mode === "chat") {
    const reply = await runChatFlow({ sid, message });
    return res.json({
      reply: enforcePiper(reply),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    });
  }

  // 🔒 PLAN MODE — MUST PRODUCE ACTIONS
  const result = await runPlannerFlow({
    sid,
    message,
    req,
  });

  // Absolute safety check
  if (!Array.isArray(result.proposed) || result.proposed.length === 0) {
    throw new Error("Planner invariant violated: no proposed actions");
  }

  return res.json(result);
});

export default router;
export const chatHandler = router;
