// src/routes/chat.js
import { Router } from "express";
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";
import { piperSystemPrompt, enforcePiper } from "../services/persona.js";

import { triageNeedsPlanner } from "../planner/triage.js";
import { buildSnapshot } from "../planner/snapshot.js";
import { llmRespondAndPlan } from "../planner/planner.js";
import { compilePlanToActions } from "../planner/compiler.js";
import { addAction } from "../actions/store.js";

const sessions = new Map();

function newId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function buildPiperJsonChatMessages(message) {
  // We instruct strict JSON so we can reliably pull emotion & intensity.
  return [
    {
      role: "system",
      content:
        piperSystemPrompt() +
        "\nReturn STRICT JSON ONLY, no markdown, no extra text.\n" +
        "Schema:\n" +
        '{ "text": string, "emotion": "neutral"|"warm"|"amused"|"confident"|"serious"|"concerned"|"excited"|"apologetic"|"dry", "intensity": number }\n' +
        "Rules:\n" +
        "- text: your actual reply to the user.\n" +
        "- emotion: pick one that matches your delivery.\n" +
        "- intensity: 0.0 to 1.0 (0.4 is normal).\n" +
        "- Be witty/sharp only when appropriate; never rude.\n" +
        '- Use "sir" at most once.\n',
    },
    { role: "user", content: String(message || "") },
  ];
}

function safeEmotion(obj) {
  const e = String(obj?.emotion || "neutral").toLowerCase();
  const allowed = new Set([
    "neutral",
    "warm",
    "amused",
    "confident",
    "serious",
    "concerned",
    "excited",
    "apologetic",
    "dry",
  ]);
  return allowed.has(e) ? e : "neutral";
}

function safeIntensity(obj) {
  const n = Number(obj?.intensity);
  if (!Number.isFinite(n)) return 0.4;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function parsePiperJson(content) {
  const obj = extractFirstJsonObject(content);
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.text !== "string" || !obj.text.trim()) return null;
  return {
    text: obj.text.trim(),
    emotion: safeEmotion(obj),
    intensity: safeIntensity(obj),
  };
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
      reply: enforcePiper("What title would you like, sir? Put it in quotes."),
      emotion: "neutral",
      intensity: 0.4,
      proposed: [],
    };
  }
  const id = newId();
  return {
    reply: enforcePiper(
      `Queued for approval, sir. I will set the page title to "${desired}".`
    ),
    emotion: "confident",
    intensity: 0.5,
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

      if (looksLikeTitleRequest(msg)) {
        const out = handleTitleRequest(msg);
        s.turns += 1;
        s.lastIntent = "change";
        s.lastMsg = msg;
        sessions.set(sid, s);
        return res.json(out);
      }

      // If actions are not allowed, do pure chat.
      if (!allowActions) {
        const raw = await callOllama(buildPiperJsonChatMessages(msg), {
          model: process.env.OLLAMA_MODEL || "llama3.1",
          format: "json",
        });

        const parsed = parsePiperJson(raw);
        const replyText = enforcePiper(parsed?.text || raw || "…");

        s.turns += 1;
        s.lastIntent = "chat";
        s.lastMsg = msg;
        sessions.set(sid, s);

        return res.json({
          reply: replyText,
          emotion: parsed?.emotion || "neutral",
          intensity: parsed?.intensity ?? 0.4,
          proposed: [],
        });
      }

      const triage = await triageNeedsPlanner({
        message: msg,
        lastIntent: s.lastIntent || "chat",
      });

      // CHAT
      if (triage.mode === "chat") {
        const raw = await callOllama(buildPiperJsonChatMessages(msg), {
          model: process.env.OLLAMA_MODEL || "llama3.1",
          format: "json",
        });

        const parsed = parsePiperJson(raw);
        const replyText = enforcePiper(parsed?.text || raw || "…");

        s.turns += 1;
        s.lastIntent = "chat";
        s.lastMsg = msg;
        sessions.set(sid, s);

        return res.json({
          reply: replyText,
          emotion: parsed?.emotion || "neutral",
          intensity: parsed?.intensity ?? 0.4,
          proposed: [],
        });
      }

      // CHANGE / PLAN
      const snapshot = await buildSnapshot();

      const planned = await llmRespondAndPlan({
        message: msg,
        snapshot,
        lastIntent: s.lastIntent || "chat",
      });

      const compiled = compilePlanToActions(planned, snapshot);

      const proposed = [];
      for (const a of compiled.actions || []) {
        const id = addAction(a);
        proposed.push({ id, ...a.summary });
      }

      s.turns += 1;
      s.lastIntent = "change";
      s.lastMsg = msg;
      sessions.set(sid, s);

      // For planner replies, we keep emotion neutral unless you want it there too later.
      return res.json({
        reply: enforcePiper(planned.reply || "Understood, sir."),
        emotion: "neutral",
        intensity: 0.4,
        proposed,
      });
    } catch (e) {
      return res.status(500).json({
        reply: enforcePiper("Something went wrong, sir."),
        emotion: "concerned",
        intensity: 0.5,
        error: String(e?.message || e),
      });
    }
  });

  return r;
}
