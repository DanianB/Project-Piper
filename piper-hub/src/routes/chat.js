// src/routes/chat.js
import { Router } from "express";
import { enforceJarvis } from "../services/persona.js";
import { callOllama } from "../services/ollama.js";
import { extractIntent } from "../planner/intent.js";

import { triageNeedsPlanner } from "../planner/triage.js";
import { buildSnapshot } from "../planner/snapshot.js";
import { llmRespondAndPlan } from "../planner/planner.js";
import { compilePlanToActions } from "../planner/compiler.js";

import { addAction } from "../actions/store.js";

const sessions = new Map();

function newId() {
  return `act_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

/**
 * Fast chat mode (no actions). Must not claim changes were executed.
 */
async function fastChatReply(msg) {
  const sys =
    "You are Piper — calm, confident, concise Jarvis-style assistant.\n" +
    "Never bubbly. No tool/platform talk. No emoji spam.\n" +
    "Use 'sir' occasionally, not every sentence.\n" +
    "Keep replies to 1–2 sentences unless asked for more.\n\n" +
    "CRITICAL TRUTH RULE:\n" +
    "- In this mode you cannot run commands or change files/UI.\n" +
    "- Never claim something was changed or completed.\n";

  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: String(msg || "") },
    ],
    { timeoutMs: 15000 }
  );
  return enforceJarvis(out);
}

export function chatRoutes() {
  const r = Router();

  r.post("/chat", async (req, res) => {
    try {
      const { sessionId, message, readOnly } = req.body || {};
      const msg = String(message || "").trim();
      if (!msg) return res.json({ reply: "…", proposed: [] });

      const sid = String(sessionId || "default");
      const s = sessions.get(sid) || { turns: 0, lastIntent: "chat" };

      // TRIAGE (with light context)
      const triage = await triageNeedsPlanner({
        message: msg,
        lastIntent: s.lastIntent || "chat",
      });

      const mode =
        triage.mode === "plan" ||
        (s.lastIntent === "plan" && triage.confidence < 0.95)
          ? "plan"
          : "chat";

      console.log(
        `[chat] triage mode=${mode} action=${triage.action} (raw=${
          triage.mode
        } conf=${triage.confidence.toFixed(2)}) msg="${msg.slice(0, 80)}"`
      );

      // FAST CHAT
      if (mode === "chat") {
        s.lastIntent = "chat";
        const reply = await fastChatReply(msg);
        s.turns += 1;
        sessions.set(sid, s);
        return res.json({ reply, proposed: [] });
      }

      // PLAN
      s.lastIntent = "plan";

      if (Boolean(readOnly)) {
        s.turns += 1;
        sessions.set(sid, s);
        return res.json({
          reply: enforceJarvis(
            "Read-only is enabled, sir. I won’t queue actions."
          ),
          proposed: [],
        });
      }

      // Snapshot for planner/compiler
      const snapshot = await buildSnapshot();

      // Call planner
      let plan = await llmRespondAndPlan({ message: msg, snapshot });
      let ops = Array.isArray(plan.ops) ? plan.ops : [];
      let hasOps = ops.length > 0;

      // One-shot retry if model didn't emit actionable ops
      if (!plan.requiresApproval || !hasOps) {
        const retryMsg =
          msg +
          "\n\nSYSTEM NOTE: This request requires approval-gated action(s). " +
          "You MUST output JSON with requiresApproval=true and at least one actionable op. " +
          "For simple UI changes, do not ask preference questions. Queue the minimal safe change.";
        plan = await llmRespondAndPlan({ message: retryMsg, snapshot });
        ops = Array.isArray(plan.ops) ? plan.ops : [];
        hasOps = ops.length > 0;
      }

      // ---------- Fallback intent extraction ----------
      if (!hasOps && triage.action === "change") {
        const intent = await extractIntent(msg);

        if (intent.kind === "ui_change" && intent.changeKind) {
          plan = {
            reply: "Queued for approval, sir.",
            requiresApproval: true,
            ops: [
              {
                op: "ui_change",
                target: { kind: "button", label: intent.targetLabel || "send" },
                change: { kind: intent.changeKind, value: intent.value || "" },
                why: "Apply the requested UI styling change.",
              },
            ],
          };
        }
      }

      // ---------- Extract read_snippet ops (handled directly here) ----------
      // This avoids needing compiler support and keeps the milestone scoped.
      const readOps = (Array.isArray(plan.ops) ? plan.ops : []).filter(
        (o) => o && typeof o === "object" && o.op === "read_snippet"
      );

      const readActions = readOps.map((o) => {
        const rel = String(o.path || o.file || "").trim();
        const title = `Read snippet: ${rel || "file"}`;
        const payload = {
          path: rel,
        };

        if (o.aroundLine != null) payload.aroundLine = Number(o.aroundLine);
        if (o.radius != null) payload.radius = Number(o.radius);
        if (o.startLine != null) payload.startLine = Number(o.startLine);
        if (o.endLine != null) payload.endLine = Number(o.endLine);
        if (o.maxLines != null) payload.maxLines = Number(o.maxLines);

        return {
          type: "read_snippet",
          title,
          reason: String(
            o.why || "Inspect a portion of a file to ground a safe change."
          ),
          payload,
        };
      });

      // Remove read_snippet ops before compiling the rest
      if (readOps.length) {
        plan = {
          ...plan,
          ops: (Array.isArray(plan.ops) ? plan.ops : []).filter(
            (o) => o && o.op !== "read_snippet"
          ),
        };
      }

      const compiled = compilePlanToActions({
        plan,
        snapshot,
        readOnly: false,
      });

      console.log(`[chat] compiled actions=${(compiled.actions || []).length}`);

      const allActions = [...(readActions || []), ...(compiled.actions || [])];

      if (!allActions.length) {
        s.turns += 1;
        sessions.set(sid, s);
        return res.json({ reply: enforceJarvis(compiled.reply), proposed: [] });
      }

      const proposed = [];
      for (const a of allActions) {
        const id = newId();
        addAction({
          id,
          type: a.type,
          title: a.title || a.type,
          reason: a.reason || "",
          payload: a.payload || {},
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: null,
        });
        proposed.push({ id, type: a.type, title: a.title || a.type });
      }

      s.turns += 1;
      sessions.set(sid, s);

      const finalReply =
        allActions.length &&
        typeof compiled.reply === "string" &&
        /couldn['’]t|cannot|unable/i.test(compiled.reply)
          ? "Queued for approval, sir."
          : String(compiled.reply || "Queued for approval, sir.");

      return res.json({
        reply: enforceJarvis(finalReply),
        proposed,
      });
    } catch (e) {
      console.error("[chat] error", e);
      return res
        .status(500)
        .json({ reply: "⚠️ Something went wrong.", proposed: [] });
    }
  });

  return r;
}
