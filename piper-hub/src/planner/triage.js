// src/planner/triage.js
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";

/**
 * Returns:
 * { mode: "chat"|"plan", action: "none"|"restart"|"shutdown"|"change"|"command"|"device", confidence: number }
 */
export async function triageNeedsPlanner({ message, lastIntent }) {
  const sys =
    "You are a strict intent triage classifier for Piper.\n" +
    "Return STRICT JSON only:\n" +
    '{"mode":"chat"|"plan","action":"none"|"restart"|"shutdown"|"change"|"command"|"device","confidence":0.0}\n\n' +
    "Definitions:\n" +
    "- mode=plan for any real-world action request (restart/shutdown, modify UI/CSS/HTML, change code/files, run commands, control apps/devices).\n" +
    "- mode=chat only for pure conversation.\n" +
    "- action=restart if user asks to restart Piper/server.\n" +
    "- action=shutdown if user asks to turn off/stop Piper/server.\n" +
    "- action=change for UI/code/file edits.\n" +
    "- action=command for running shell/powershell/cmd.\n" +
    "- action=device for opening/controlling apps/devices/agents.\n" +
    "- If uncertain, prefer mode=plan.\n\n" +
    "Examples:\n" +
    "Hello -> {mode:chat,action:none}\n" +
    "Please restart -> {mode:plan,action:restart}\n" +
    "Turn off -> {mode:plan,action:shutdown}\n" +
    "Remove background from send button -> {mode:plan,action:change}\n" +
    "Run a command -> {mode:plan,action:command}\n";

  const payload = {
    message: String(message || ""),
    lastIntent: String(lastIntent || ""),
  };

  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(payload) },
    ],
    { timeoutMs: 8000 }
  );

  const j = extractFirstJsonObject(out);
  if (j && (j.mode === "chat" || j.mode === "plan")) {
    const c = Number(j.confidence);
    const confidence = Number.isFinite(c) ? c : 0.7;

    const action = [
      "none",
      "restart",
      "shutdown",
      "change",
      "command",
      "device",
    ].includes(j.action)
      ? j.action
      : j.mode === "plan"
      ? "change"
      : "none";

    return { mode: j.mode, action, confidence };
  }

  // Safe fallback: plan
  return { mode: "plan", action: "change", confidence: 0.6 };
}
