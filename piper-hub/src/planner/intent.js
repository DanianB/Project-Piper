// src/planner/intent.js
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";

/**
 * Strict fallback intent extractor.
 * Only used when triage says PLAN/CHANGE but the planner fails to emit ops.
 *
 * Returns:
 * { kind: "ui_change"|"edit_file"|"run_cmd"|"none", targetLabel?:string, changeKind?:string, value?:string }
 */
export async function extractIntent(message) {
  const sys =
    "You are a strict intent extractor for Piper.\n" +
    "Return STRICT JSON only:\n" +
    '{"kind":"ui_change"|"edit_file"|"run_cmd"|"none","targetLabel":"string?","changeKind":"string?","value":"string?"}\n\n' +
    "Rules:\n" +
    "- If user asks to modify UI styling (color/background/spacing), return kind=ui_change.\n" +
    '- For send button requests, set targetLabel="send".\n' +
    "- Use changeKind values: remove_background | set_background.\n" +
    "- If user asks to run a command, return kind=run_cmd with value=the command.\n" +
    "- If unsure, return none.\n";

  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: String(message || "") },
    ],
    { timeoutMs: Number(process.env.OLLAMA_PLANNER_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || 60000), numPredict: Number(process.env.OLLAMA_PLANNER_NUM_PREDICT || 256) }
  );

  const j = extractFirstJsonObject(out);
  if (!j || typeof j !== "object") return { kind: "none" };

  const kind = ["ui_change", "edit_file", "run_cmd", "none"].includes(j.kind)
    ? j.kind
    : "none";
  const targetLabel = typeof j.targetLabel === "string" ? j.targetLabel : "";
  const changeKind = typeof j.changeKind === "string" ? j.changeKind : "";
  const value = typeof j.value === "string" ? j.value : "";

  return { kind, targetLabel, changeKind, value };
}
