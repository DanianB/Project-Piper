// src/routes/chat/workflows/chatFlow.js
// Chat-only workflow (no side effects).
// Goals:
// - Never echo the user's message as the reply.
// - Deterministic greetings via deterministic/greetings.js.
// - Light conversational continuity using in-RAM convo memory.

import { callOllama } from "../../../services/ollama.js";
import { piperSystemPrompt } from "../../../services/persona.js";
import { getConversationMessages, pushConversationTurn } from "../../../services/mind.js";
import { isGreeting, greetingReply } from "../deterministic/greetings.js";

function safeText(x) {
  return String(x || "").trim();
}

function looksLikeEcho(reply, userMsg) {
  const r = safeText(reply).toLowerCase();
  const u = safeText(userMsg).toLowerCase();
  if (!r || !u) return false;
  if (r === u) return true;
  // common echo variant: assistant repeats with punctuation differences
  const rn = r.replace(/[.?!]+$/g, "");
  const un = u.replace(/[.?!]+$/g, "");
  return rn === un;
}

export default async function runChatFlow({ sid, message }) {
  const m = safeText(message);

  // Deterministic greetings (use the existing greetings module)
  if (isGreeting(m)) {
    const r = greetingReply(m);
    pushConversationTurn(sid, "user", m);
    pushConversationTurn(sid, "assistant", r);
    return r;
  }

  // Pull a small amount of convo context to improve continuity.
  const convo = getConversationMessages(sid)
    .slice(-12)
    .filter((x) => x && typeof x.content === "string")
    .map((x) => ({
      role: x.role === "assistant" ? "assistant" : "user",
      content: safeText(x.content).slice(0, 800),
    }));

  try {
    const out = await callOllama(
      [
        {
          role: "system",
          content:
            piperSystemPrompt() +
            "\nChat mode only. No tools. No plans. Reply in 1–2 sentences. Do not repeat the user's message verbatim.",
        },
        ...convo,
        { role: "user", content: m },
      ],
      { timeoutMs: Number(process.env.OLLAMA_CHAT_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || 30000), numPredict: Number(process.env.OLLAMA_CHAT_NUM_PREDICT || 96) }
    );

    let text = safeText(out);
    if (!text || looksLikeEcho(text, m)) text = "Understood, sir.";

    pushConversationTurn(sid, "user", m);
    pushConversationTurn(sid, "assistant", text);
    return text;
  } catch {
    const fallback = "Understood, sir.";
    pushConversationTurn(sid, "user", m);
    pushConversationTurn(sid, "assistant", fallback);
    return fallback;
  }
}
