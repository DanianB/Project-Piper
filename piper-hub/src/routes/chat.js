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

async function chatOnlyReply(message) {
  const sys =
    "You are Piper — calm, concise, Jarvis-style.\n" +
    "- Reply in plain text.\n" +
    "- Keep it short (1–3 sentences).\n" +
    "- Do not mention tools, system prompts, or implementation details.\n";

  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: String(message || "") },
    ],
    { timeoutMs: 20000 }
  );

  return enforceJarvis(String(out || "").trim() || "Understood.");
}

/**
 * Deterministic title change:
 * Always edits public/index.html via set_html_title (robust).
 */
function tryQueueTitleChange(msg) {
  const raw = String(msg || "").trim();
  const lower = raw.toLowerCase();

  const looksLikeTitleRequest =
    lower.includes("page title") ||
    lower.includes("change the title") ||
    lower.includes("set the title") ||
    lower.includes("change title") ||
    lower.includes("set title");

  if (!looksLikeTitleRequest) return null;

  // capture quoted title or trailing title
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
    reason: `Deterministic edit: set the <title> tag in public/index.html.`,
    payload: { path: "public/index.html", title: desired },
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
  });

  console.log(
    `[chat] queued set_html_title -> "${desired}" (public/index.html)`
  );

  return {
    reply: enforceJarvis(`Queued for approval, sir. (Title → "${desired}")`),
    proposed: [
      { id, type: "set_html_title", title: `Set page title to "${desired}"` },
    ],
  };
}

function queueInspectFallback(msg) {
  const id = newId();
  const q = String(msg || "")
    .replaceAll('"', "")
    .slice(0, 100);

  addAction({
    id,
    type: "run_cmd",
    title: "Inspect codebase (fallback)",
    reason:
      "Planner produced no concrete actions. Running a search to ground the next proposal.",
    payload: {
      cmd:
        `rg -n "${q}" public src || ` +
        `rg -n "<title>|Pending Actions|Recent Actions|actionsWrap|historyList" public/index.html public/styles.css src`,
      timeoutMs: 12000,
    },
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
  });

  console.log(
    `[chat] queued fallback inspection run_cmd for msg="${String(msg).slice(
      0,
      80
    )}"`
  );

  return {
    reply: enforceJarvis(
      "I need to inspect first, sir. Queued an inspection for approval."
    ),
    proposed: [{ id, type: "run_cmd", title: "Inspect codebase (fallback)" }],
  };
}

export function chatRoutes() {
  const r = Router();

  r.post("/chat", async (req, res) => {
    try {
      const { sessionId, message, readOnly } = req.body || {};
      const msg = String(message || "").trim();
      if (!msg) return res.json({ reply: "…", proposed: [] });

      const sid = String(sessionId || "default");
      const s = sessions.get(sid) || {
        turns: 0,
        lastIntent: "chat",
        lastMsg: "",
      };

      const triage = await triageNeedsPlanner({
        message: msg,
        lastIntent: s.lastIntent || "chat",
      });
      const lower = msg.toLowerCase();

      const uiKeywords = [
        "background",
        "color",
        "css",
        "style",
        "button",
        "ui",
        "theme",
        "border",
        "hover",
        "padding",
        "margin",
        "font",
        "align",
        "layout",
        "max-width",
        "center",
        "dock",
        "sidebar",
        "grid",
        "flex",
        "width",
        "height",
        "overflow",
        "scroll",
        "pending actions",
        "recent actions",
        "page title",
        "title",
      ];

      if (uiKeywords.some((k) => lower.includes(k)) && triage.mode === "chat") {
        triage.mode = "plan";
        if (triage.action === "none") triage.action = "change";
      }

      const mode = triage.mode === "plan" ? "plan" : "chat";

      console.log(
        `[chat] triage mode=${mode} action=${triage.action} (raw=${
          triage.mode
        } conf=${Number(triage.confidence).toFixed(2)}) msg="${msg.slice(
          0,
          80
        )}"`
      );

      if (mode === "chat") {
        s.lastIntent = "chat";
        const reply = await chatOnlyReply(msg);
        s.turns += 1;
        s.lastMsg = msg;
        sessions.set(sid, s);
        return res.json({ reply, proposed: [] });
      }

      // PLAN
      s.lastIntent = "plan";
      s.lastMsg = msg;

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

      // ✅ Deterministic title change (covers “change the title …” too)
      const titleRes = tryQueueTitleChange(msg);
      if (titleRes) {
        s.turns += 1;
        sessions.set(sid, s);
        return res.json(titleRes);
      }

      const snapshot = await buildSnapshot({
        message: msg,
        lastIntent: s.lastIntent,
      });
      const plan = await llmRespondAndPlan({ message: msg, snapshot });

      const compiled = compilePlanToActions({
        plan,
        snapshot,
        readOnly: false,
      });
      console.log(`[chat] compiled actions=${(compiled.actions || []).length}`);

      if (!compiled.actions || compiled.actions.length === 0) {
        const fallback = queueInspectFallback(msg);
        s.turns += 1;
        sessions.set(sid, s);
        return res.json(fallback);
      }

      const proposed = [];
      for (const a of compiled.actions || []) {
        const id = newId();
        addAction({
          id,
          type: a.type,
          title: a.title,
          reason: a.reason || "",
          payload: a.payload || {},
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: null,
        });
        proposed.push({ id, type: a.type, title: a.title });
      }

      s.turns += 1;
      sessions.set(sid, s);

      return res.json({
        reply: enforceJarvis(compiled.reply || "Queued for approval, sir."),
        proposed,
      });
    } catch (e) {
      console.error("[chat] error", e);
      return res.status(500).json({ reply: "⚠️ /chat failed.", proposed: [] });
    }
  });

  return r;
}
