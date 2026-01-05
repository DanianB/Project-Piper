// src/planner/triage.js
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";

/**
 * Deterministic triage override:
 * If the user message clearly requests a change/command, force plan mode.
 * This prevents the system from "chatting" when it should inspect/patch.
 */
function deterministicTriage(message) {
  const m = String(message || "").trim();
  const lower = m.toLowerCase();

  // hard commands
  if (/^(restart)\b/.test(lower)) {
    return { mode: "plan", action: "restart", confidence: 1.0 };
  }
  if (/^(off|shutdown|power\s*off|turn\s*off)\b/.test(lower)) {
    return { mode: "plan", action: "off", confidence: 1.0 };
  }

  // strong change intent
  const changeCues = [
    "dock",
    "move",
    "below",
    "under",
    "above",
    "left",
    "right",
    "resize",
    "layout",
    "ui",
    "css",
    "style",
    "theme",
    "panel",
    "tab",
    "button",
    "pending actions",
    "recent actions",
    "title",
    "background",
    "padding",
    "margin",
    "font",
    "align",
    "center",
    "width",
    "height",
    "scroll",
    "overflow",
    "fix",
    "update",
    "change",
    "set",
  ];

  const isChange = changeCues.some((k) => lower.includes(k));
  if (isChange) {
    return { mode: "plan", action: "change", confidence: 1.0 };
  }

  // file/document creation intent
  const fileCues = [
    "create a file",
    "write a document",
    "make a folder",
    "create a folder",
    "save it",
    "put it in",
  ];
  if (fileCues.some((k) => lower.includes(k))) {
    return { mode: "plan", action: "command", confidence: 1.0 };
  }

  return null;
}

function sysPrompt() {
  return (
    "You are a triage classifier for Piper.\n" +
    "Classify the user message into:\n" +
    '- mode: "chat" or "plan"\n' +
    '- action (only if plan): "change" | "command" | "restart" | "off" | "none"\n' +
    "Rules:\n" +
    "- If the user asks to change UI/layout/CSS/title, use plan/change.\n" +
    "- If the user asks to create folders/files or run commands, use plan/command.\n" +
    "- If the user says restart/off, use plan/restart or plan/off.\n" +
    "- Otherwise use chat/none.\n" +
    "Output JSON only.\n"
  );
}

export async function triageNeedsPlanner({ message, lastIntent }) {
  // ✅ deterministic override first
  const det = deterministicTriage(message);
  if (det) return { ...det, confidence: det.confidence ?? 1.0 };

  // Fallback to LLM triage (your existing behavior)
  try {
    const out = await callOllama(
      [
        { role: "system", content: sysPrompt() },
        {
          role: "user",
          content: JSON.stringify({
            message: String(message || ""),
            lastIntent: String(lastIntent || "chat"),
          }),
        },
      ],
      { timeoutMs: 12000 }
    );

    const j = extractFirstJsonObject(out) || {};
    const mode = j.mode === "plan" ? "plan" : "chat";
    const action =
      mode === "plan" && typeof j.action === "string" ? j.action : "none";

    let confidence = Number(j.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.5;

    return { mode, action, confidence };
  } catch {
    // safest default
    return { mode: "chat", action: "none", confidence: 0.5 };
  }
}
