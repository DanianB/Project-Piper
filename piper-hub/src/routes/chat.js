// src/routes/chat.js
import { Router } from "express";
import { enforceJarvis } from "../services/persona.js";
import { callOllama } from "../services/ollama.js";

import { triageNeedsPlanner } from "../planner/triage.js";
import { buildSnapshot } from "../planner/snapshot.js";
import { llmRespondAndPlan } from "../planner/planner.js";
import { compilePlanToActions } from "../planner/compiler.js";

import { addAction } from "../actions/store.js";

const sessions = new Map();

function newId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function shouldAllowActions(reqBody) {
  const userInitiated = reqBody?.userInitiated === true;
  const readOnly = Boolean(reqBody?.readOnly);
  return userInitiated && !readOnly;
}

function reqMeta(req) {
  const ua = String(req.headers["user-agent"] || "");
  const referer = String(req.headers["referer"] || "");
  const ip =
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    "";
  return { ip: String(ip), ua, referer };
}

function buildSimpleChatMessages(message) {
  return [
    {
      role: "system",
      content:
        "You are Piper. Be concise, helpful, and grounded. Do not propose or execute tool actions unless explicitly asked.",
    },
    { role: "user", content: String(message || "") },
  ];
}

// Deterministic title change (approval-gated)
function tryQueueTitleChange(raw) {
  const m =
    raw.match(/(?:page\s+title|title)\s+to\s+['"“”](.+?)['"“”]/i) ||
    raw.match(/(?:page\s+title|title)\s+to\s+(.+)$/i);

  if (!m) return null;

  const desired = String(m[1] || "").trim();
  if (!desired) return null;

  const id = newId();

  addAction({
    id,
    type: "set_html_title",
    title: `Set page title to "${desired}"`,
    reason: "Deterministic edit: set the <title> tag in public/index.html.",
    payload: { path: "public/index.html", title: desired },
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
  });

  return {
    reply: enforceJarvis("Queued for approval, sir."),
    proposed: [
      { id, type: "set_html_title", title: `Set page title to "${desired}"` },
    ],
  };
}

export function chatRoutes() {
  const r = Router();

  r.post("/chat", async (req, res) => {
    try {
      const { sessionId, message } = req.body || {};
      const msg = String(message || "").trim();
      if (!msg) return res.json({ reply: "…", proposed: [] });

      const sid = String(sessionId || "default");
      const s = sessions.get(sid) || {
        turns: 0,
        lastIntent: "chat",
        lastMsg: "",
      };

      const allowActions = shouldAllowActions(req.body);
      const meta = reqMeta(req);

      // Log EVERY chat call so we can identify "ghost" callers.
      console.log(
        `[chat] ip=${meta.ip} allowActions=${allowActions} userInitiated=${
          req.body?.userInitiated === true
        } readOnly=${Boolean(req.body?.readOnly)} ua="${meta.ua.slice(
          0,
          80
        )}" referer="${meta.referer.slice(0, 140)}" msg="${msg.slice(0, 180)}"`
      );

      // If actions are not allowed, do pure chat (no addAction anywhere).
      if (!allowActions) {
        const reply = await callOllama(buildSimpleChatMessages(msg), {
          model: process.env.OLLAMA_MODEL || "llama3.1",
        });
        s.turns += 1;
        s.lastIntent = "chat";
        s.lastMsg = msg;
        sessions.set(sid, s);
        return res.json({ reply: enforceJarvis(reply || "…"), proposed: [] });
      }

      const triage = await triageNeedsPlanner({
        message: msg,
        lastIntent: s.lastIntent || "chat",
      });

      // CHAT
      if (triage.mode === "chat") {
        const reply = await callOllama(buildSimpleChatMessages(msg), {
          model: process.env.OLLAMA_MODEL || "llama3.1",
        });
        s.turns += 1;
        s.lastIntent = "chat";
        s.lastMsg = msg;
        sessions.set(sid, s);
        return res.json({ reply: enforceJarvis(reply || "…"), proposed: [] });
      }

      // PLAN
      s.lastIntent = "plan";
      s.lastMsg = msg;

      // Deterministic title change
      const titleRes = tryQueueTitleChange(msg);
      if (titleRes) {
        s.turns += 1;
        sessions.set(sid, s);
        return res.json(titleRes);
      }

      // Restart/shutdown stay approval-gated
      if (triage.action === "restart") {
        const id = newId();
        addAction({
          id,
          type: "restart_piper",
          title: "Restart Piper",
          reason: "User requested a restart.",
          payload: {},
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: null,
        });
        s.turns += 1;
        sessions.set(sid, s);
        return res.json({
          reply: enforceJarvis("Queued for approval, sir."),
          proposed: [{ id, type: "restart_piper", title: "Restart Piper" }],
        });
      }

      if (triage.action === "shutdown") {
        const id = newId();
        addAction({
          id,
          type: "shutdown_piper",
          title: "Turn Piper off",
          reason: "User requested shutdown.",
          payload: {},
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: null,
        });
        s.turns += 1;
        sessions.set(sid, s);
        return res.json({
          reply: enforceJarvis("Queued for approval, sir."),
          proposed: [{ id, type: "shutdown_piper", title: "Turn Piper off" }],
        });
      }

      // Planner path
      const snapshot = await buildSnapshot({ message: msg, sessionId: sid });

      const plan = await llmRespondAndPlan({
        message: msg,
        snapshot,
        triage,
        readOnly: false,
      });

      const compiled = compilePlanToActions({
        plan,
        snapshot,
        readOnly: false,
      });

      const actions = Array.isArray(compiled.actions) ? compiled.actions : [];
      const proposed = [];

      for (const a of actions) {
        const id = newId();
        addAction({
          id,
          type: a.type,
          title: a.title || a.type,
          reason: a.reason || "Proposed by Piper.",
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

      return res.json({
        reply: enforceJarvis(
          compiled.reply ||
            (proposed.length ? "Queued for approval, sir." : "…")
        ),
        proposed,
      });
    } catch (e) {
      console.error("[chat] error", e);
      return res.status(500).json({ reply: "⚠️ /chat failed.", proposed: [] });
    }
  });

  return r;
}
