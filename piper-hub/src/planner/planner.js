// src/planner/planner.js
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";

function isChangeish(message) {
  const m = String(message || "").toLowerCase();
  return /dock|move|layout|ui|css|style|position|below|under|bottom|beneath|above|left|right|center|max-?width|overflow|scroll|fix|resize|panel|sidebar|pending actions|recent actions/i.test(
    m
  );
}

function looksLikeDockPendingActions(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("dock") &&
    m.includes("pending") &&
    m.includes("actions") &&
    (m.includes("below") || m.includes("under") || m.includes("beneath")) &&
    m.includes("chat")
  );
}

function looksLikeRestart(message) {
  const m = String(message || "")
    .trim()
    .toLowerCase();
  return (
    m === "restart" || m.startsWith("restart ") || m.includes("please restart")
  );
}

function looksLikeTurnOff(message) {
  const m = String(message || "")
    .trim()
    .toLowerCase();
  return (
    m === "off" ||
    m === "turn off" ||
    m.includes("turn off piper") ||
    m.includes("shutdown") ||
    m.includes("shut down")
  );
}

function sysPrompt() {
  return (
    "You are Piper — a calm, confident, concise Jarvis-style local assistant.\n" +
    "You help modify a local codebase via an approval-gated action system.\n\n" +
    "Non-negotiables:\n" +
    "- Inspect → Ground → Act. Never invent selectors, functions, or file content.\n" +
    "- Prefer general capability over special-case hacks.\n" +
    "- Minimal, deterministic edits (avoid whole-file rewrites/formatting).\n" +
    "- Approval is sacred: only propose ops that can be executed deterministically.\n" +
    "- For user folders outside the repo (Desktop/Downloads/Documents), use paths like known:desktop/Folder/file.txt (or known:downloads, known:documents). Never use /Desktop or absolute Windows paths.\n" +
    "- If you can determine the requested state is already true, reply 'Already done, sir.' and return requiresApproval:false with ops:[]\n\n" +
    "Grounding:\n" +
    "- Prefer using snapshot.inspectionFacts and snapshot.uiFacts over raw command logs.\n" +
    "- Only use selectors that exist in snapshot.uiFacts or snapshot.inspectionFacts.selectorsFound.\n\n" +
    "Action format (JSON only):\n" +
    "{\n" +
    '  "reply": "string",\n' +
    '  "requiresApproval": true|false,\n' +
    '  "ops": [\n' +
    '     {"op":"css_patch","file":"public/styles.css","selectors":["."] ,"set":{"prop":"value"},"unset":["prop"],"why":"."},\n' +
    '     {"op":"apply_patch","path":".","edits":[{"find":"EXACT","replace":"EXACT","mode":"once|all|append"}],"why":"..."},\n' +
    '     {"op":"write_file","path":".","content":".","why":"."},\n' +
    '     {"op":"mkdir","path":".","why":"."},\n' +
    '     {"op":"run_cmd","cmd":".","timeoutMs":12000,"why":"."},\n' +
    '     {"op":"read_snippet","path":".","aroundLine":120,"radius":60,"why":"."},\n' +
    '     {"op":"restart","why":"..."},\n' +
    '     {"op":"off","why":"..."}\n' +
    "  ]\n" +
    "}\n"
  );
}

export async function llmRespondAndPlan({ message, snapshot }) {
  // --- Deterministic lifecycle ops (do NOT send to LLM) ---
  if (looksLikeRestart(message)) {
    return {
      reply: "Understood. I can restart Piper after approval, sir.",
      requiresApproval: true,
      ops: [{ op: "restart", why: "User requested restart." }],
    };
  }

  if (looksLikeTurnOff(message)) {
    return {
      reply: "Understood. I can turn Piper off after approval, sir.",
      requiresApproval: true,
      ops: [{ op: "off", why: "User requested shutdown/off." }],
    };
  }

  // --- Prefer LLM for general planning ---
  const sys = sysPrompt();
  const payload = {
    message: String(message || ""),
    capabilities: snapshot.capabilities,
    uiMapSummary: snapshot.uiMapSummary,
    uiFacts: snapshot.uiFacts,
    inspectionStage: snapshot.inspectionStage,
    inspectionFacts: snapshot.inspectionFacts,
    allowlistedFiles: snapshot.allowlistedFiles || [],
  };

  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(payload) },
    ],
    { timeoutMs: 28000 }
  );

  const j = extractFirstJsonObject(out);

  if (!j || typeof j !== "object") {
    return { reply: "Understood, sir.", requiresApproval: false, ops: [] };
  }

  if (typeof j.reply !== "string") j.reply = "Understood, sir.";
  if (typeof j.requiresApproval !== "boolean") j.requiresApproval = false;
  if (!Array.isArray(j.ops)) j.ops = [];

  // If user asked for change but model returned no ops, keep approval true
  // (compiler may escalate inspection safely).
  if (isChangeish(message) && j.ops.length === 0) j.requiresApproval = true;

  return j;
}
