// src/planner/triage.js
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";

/**
 * Triage rule (FINAL):
 * - If the user expects a real-world effect → plan
 * - Otherwise → chat
 *
 * NO keyword gating.
 * NO UI/CSS heuristics.
 */
export async function triageNeedsPlanner({ message, lastIntent }) {
  const m = String(message || "").trim();

  // Deterministic greetings stay in chat mode (avoid LLM misclassification)
  if (/^(hi|hey|hello|yo|g'day|good (morning|afternoon|evening))\b/i.test(m)) {
    return { mode: "chat", action: "greet", confidence: 1 };
  }

  // Hard commands
  if (/^(restart|reload)\b/i.test(m)) {
    return { mode: "plan", action: "restart", confidence: 1 };
  }
  if (/^(off|shutdown|power\s*off|turn\s*off)\b/i.test(m)) {
    return { mode: "plan", action: "off", confidence: 1 };
  }

  // If the user asks to DO something (imperative), assume plan
  if (
    /^(please\s+)?(change|set|update|modify|make|add|remove|fix|edit|open|create|write|search)\b/i.test(
      m
    )
  ) {
    return { mode: "plan", action: "do", confidence: 0.9 };
  }

  // Polite action-questions are still plan ("Can you…", "Could you please…")
  if (
    /^(can|could|would|will)\s+you\b/i.test(m) &&
    /\b(change|set|update|modify|make|add|remove|fix|edit|open|create|write|search)\b/i.test(m)
  ) {
    return { mode: "plan", action: "do", confidence: 0.9 };
  }

  // Otherwise let the LLM decide conservatively
  try {
    const out = await callOllama(
      [
        {
          role: "system",
          content:
            "Classify intent. If the user expects a real-world action, return plan. Otherwise chat. JSON only.",
        },
        {
          role: "user",
          content: JSON.stringify({ message: m, lastIntent }),
        },
      ],
      { timeoutMs: Number(process.env.OLLAMA_PLANNER_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || 60000), numPredict: Number(process.env.OLLAMA_PLANNER_NUM_PREDICT || 256) }
    );

    const j = extractFirstJsonObject(out) || {};
    return {
      mode: j.mode === "plan" ? "plan" : "chat",
      action: j.action || "none",
      confidence: Number(j.confidence) || 0.6,
    };
  } catch {
    return { mode: "chat", action: "none", confidence: 0.5 };
  }
}
