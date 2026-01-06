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

function buildSimpleChatMessages(message) {
  return [
    {
      role: "system",
      content:
        "You are Piper — a calm, confident, concise Jarvis-style local assistant.\n" +
        "Be helpful and grounded.\n" +
        "Style: respectful, a little dry, efficient.\n" +
        'Address the user as "sir" occasionally (max once per reply).\n' +
        "Avoid using the user's name unless they ask you to.\n" +
        "Do not propose or execute tool actions unless explicitly asked.",
    },
    { role: "user", content: String(message || "") },
  ];
}

function looksLikeTitleRequest(message) {
  const m = String(message || "").toLowerCase();
  return (
    (m.includes("title") && (m.includes("set") || m.includes("change"))) ||
    m.startsWith("set title") ||
    m.startsWith("change title")
  );
}

function desiredTitle(message) {
  const m = String(message || "").trim();
  const match = m.match(/"(.*?)"/);
  if (match && match[1]) return match[1].trim();
  return null;
}

function handleTitleRequest(message) {
  const desired = desiredTitle(message);
  if (!desired) {
    return {
      reply: enforceJarvis("What title would you like, sir? Put it in quotes."),
      proposed: [],
    };
  }
  const id = newId();
  return {
    reply: enforceJarvis(
      `Queued for approval, sir. I will set the page title to "${desired}".`
    ),
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
      const sid = sessionId || "default";

      const allowActions = !!req?.app?.locals?.allowActions;

      const s = sessions.get(sid) || {
        turns: 0,
        lastIntent: "chat",
        lastMsg: "",
      };

      // Special-case: simple title request (kept as-is)
      if (looksLikeTitleRequest(msg)) {
        const out = handleTitleRequest(msg);
        s.turns += 1;
        s.lastIntent = "change";
        s.lastMsg = msg;
        sessions.set(sid, s);
        return res.json(out);
      }

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

      // CHANGE / PLAN
      const snapshot = await buildSnapshot();

      const planned = await llmRespondAndPlan({
        message: msg,
        snapshot,
        lastIntent: s.lastIntent || "chat",
      });

      const compiled = compilePlanToActions(planned, snapshot);

      // Store actions for UI approval queue
      const proposed = [];
      for (const a of compiled.actions || []) {
        const id = addAction(a);
        proposed.push({ id, ...a.summary });
      }

      s.turns += 1;
      s.lastIntent = "change";
      s.lastMsg = msg;
      sessions.set(sid, s);

      return res.json({
        reply: enforceJarvis(planned.reply || "Understood, sir."),
        proposed,
      });
    } catch (e) {
      return res
        .status(500)
        .json({
          reply: enforceJarvis("Something went wrong, sir."),
          error: String(e?.message || e),
        });
    }
  });

  return r;
}
