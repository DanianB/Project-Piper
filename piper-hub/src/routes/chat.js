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

  // IMPORTANT: callOllama expects an ARRAY of {role, content}
  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: String(message || "") },
    ],
    { timeoutMs: 20000 }
  );

  return enforceJarvis(String(out || "").trim() || "Understood.");
}

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

  console.log(`[chat] queued set_html_title -> "${desired}"`);

  return {
    reply: enforceJarvis(`Queued for approval, sir. (Title → "${desired}")`),
    proposed: [
      { id, type: "set_html_title", title: `Set page title to "${desired}"` },
    ],
  };
}

function queueFallbackInspection(userMessage) {
  const id = newId();

  const safeNeedle = String(userMessage || "")
    .replaceAll('"', "")
    .replaceAll("\n", " ")
    .trim()
    .slice(0, 120);

  const cmd =
    `rg -n "${safeNeedle}" public src || ` +
    `rg -n "<title>|Pending Actions|Recent Actions|actionsWrap|historyList" public/index.html public/styles.css src`;

  addAction({
    id,
    type: "run_cmd",
    title: "Inspect codebase",
    reason: "Need grounding before proposing a deterministic patch.",
    payload: { cmd, timeoutMs: 12000 },
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
  });

  console.log(
    `[chat] queued fallback inspection run_cmd for msg="${String(
      userMessage || ""
    ).slice(0, 80)}"`
  );

  return {
    reply: enforceJarvis(
      "I need to inspect first, sir. Queued an inspection for approval."
    ),
    proposed: [{ id, type: "run_cmd", title: "Inspect codebase" }],
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

      // Deterministic title change (no LLM needed)
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

      // Build snapshot + plan
      const snapshot = await buildSnapshot({
        message: msg,
        allowRunCmd: true,
        maxCmds: 1,
      });

      const plan = await llmRespondAndPlan({ message: msg, snapshot });

      const compiled = compilePlanToActions({
        plan,
        snapshot,
        readOnly: false,
      });

      const actions = Array.isArray(compiled.actions) ? compiled.actions : [];
      console.log(
        `[chat] compiled actions=${actions.length} stage=${JSON.stringify(
          plan?.stage || {}
        )}`
      );

      // If planner couldn’t produce ops, queue a safe inspection once.
      if (!actions.length) {
        // Only queue inspection if we still lack grounding.
        const hasAnyRunCmd =
          Array.isArray(snapshot?.runCmdOutputs) &&
          snapshot.runCmdOutputs.length;
        if (!hasAnyRunCmd) {
          s.turns += 1;
          sessions.set(sid, s);
          return res.json(queueFallbackInspection(msg));
        }

        // Otherwise, reply plainly (no infinite loops).
        s.turns += 1;
        sessions.set(sid, s);
        return res.json({
          reply: enforceJarvis(
            compiled.reply ||
              "I have enough context, but I can’t form a deterministic patch from it yet. Tell me exactly which panel should move where (e.g. “set #actionsWrap grid-column to 1”)."
          ),
          proposed: [],
        });
      }

      // Queue proposed actions
      const proposed = [];
      for (const a of actions) {
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
