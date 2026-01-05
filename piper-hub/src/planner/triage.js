// src/planner/triage.js
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";

/**
 * Returns:
 * { mode: "chat"|"plan", action: "none"|"restart"|"shutdown"|"change"|"command"|"device", confidence: number }
 */
export async function triageNeedsPlanner({ message, lastIntent }) {
  const msg = String(message || "");
  const lower = msg.toLowerCase();

  // --- Heuristic overrides (fast + reliable) ---
  // If user is asking about code location / code structure / where something lives, ALWAYS plan (command).
  const codeNavHints = [
    "where is",
    "where are",
    "location of",
    "located",
    "what file",
    "which file",
    "what module",
    "which module",
    "in the code",
    "in code",
    "source",
    "implementation",
    "implemented",
    "function",
    "functions",
    "voice",
    "routes",
    "route",
    "api",
    "endpoint",
    "handler",
    "export",
    "import",
    "class",
    "config",
    "settings",
    "schema",
    "database",
    "db",
  ];

  const asksToFindOrInspect =
    lower.includes("find ") ||
    lower.includes("locate ") ||
    lower.includes("identify ") ||
    lower.includes("inspect ") ||
    lower.includes("search ");

  const looksLikeCodeNav =
    asksToFindOrInspect ||
    codeNavHints.some((k) => lower.includes(k)) ||
    /(?:src\/|public\/|\.js\b|\.css\b|\.html\b)/i.test(msg);

  if (looksLikeCodeNav) {
    return { mode: "plan", action: "command", confidence: 0.96 };
  }

  // Restart/shutdown: always plan
  if (
    lower.includes("restart") &&
    (lower.includes("piper") ||
      lower.includes("server") ||
      lower.includes("hub"))
  ) {
    return { mode: "plan", action: "restart", confidence: 0.98 };
  }
  if (
    lower.includes("shutdown") ||
    lower.includes("shut down") ||
    lower.includes("turn off") ||
    lower.includes("power off")
  ) {
    if (
      lower.includes("piper") ||
      lower.includes("server") ||
      lower.includes("hub")
    ) {
      return { mode: "plan", action: "shutdown", confidence: 0.98 };
    }
  }

  // --- LLM triage (fallback) ---
  const sys =
    "You are a strict intent triage classifier for Piper.\n" +
    "Return STRICT JSON only:\n" +
    '{"mode":"chat"|"plan","action":"none"|"restart"|"shutdown"|"change"|"command"|"device","confidence":0.0}\n\n' +
    "Definitions:\n" +
    "- mode=plan for any action request: restart/shutdown, change code/files/UI, run commands, inspect code, control apps/devices.\n" +
    "- mode=chat only for pure conversation.\n" +
    "- action=command when user is asking to locate/inspect/search code or needs information to ground a safe change.\n" +
    "- action=change for UI/code edits.\n" +
    "- action=device for controlling apps/devices.\n" +
    "Rules:\n" +
    "- If uncertain, choose mode=plan.\n";

  const out = await callOllama(
    [
      { role: "system", content: sys },
      {
        role: "user",
        content: JSON.stringify({
          message: msg,
          lastIntent: String(lastIntent || "chat"),
        }),
      },
    ],
    { timeoutMs: 12000 }
  );

  const j = extractFirstJsonObject(out);

  // Normalize result
  if (j && typeof j === "object") {
    const mode = j.mode === "chat" ? "chat" : "plan";
    const confidence =
      typeof j.confidence === "number"
        ? Math.max(0, Math.min(1, j.confidence))
        : 0.6;

    const allowedActions = new Set([
      "none",
      "restart",
      "shutdown",
      "change",
      "command",
      "device",
    ]);
    const action = allowedActions.has(j.action)
      ? j.action
      : mode === "plan"
      ? "change"
      : "none";

    return { mode, action, confidence };
  }

  // Safe fallback: plan
  return { mode: "plan", action: "change", confidence: 0.6 };
}
