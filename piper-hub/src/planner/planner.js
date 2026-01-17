// src/planner/planner.js
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";

function isChangeish(message) {
  const m = String(message || "").toLowerCase();
  // Broad, non-fragile detector for "make a change" requests.
  // This is NOT meant to keyword-gate capability; it's only used to decide
  // whether an approval-gated plan should be produced.
  return /\b(change|set|update|modify|edit|make|turn|switch)\b|dock|move|layout|ui|css|style|theme|position|below|under|bottom|beneath|above|left|right|center|max-?width|overflow|scroll|fix|resize|panel|sidebar|button|background|colour|color|title|pending actions|recent actions/i.test(
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
  return `You are Piper — a calm, confident, concise Piper-style local assistant.
You are running locally in this repo. Never refer to any "Jarvis" system, team, or external operators.
You must not answer codebase-location questions from general knowledge. Never mention "training data". Always use repo tools.

If you use web.search or web.fetch, you MUST include a \`sources\` array (URLs + titles) in the plan. Do NOT put URLs in \`reply\` (TTS will read it). Put URLs only in \`sources\`.

You help modify a local codebase via an approval-gated action system.

Non-negotiables:
- Inspect → Ground → Act. Never invent selectors, functions, constants, or file content.
- If asked where/defined/located/stored in files/config/code: MUST call repo.searchText first (toolCalls) unless toolResults already provided.
- Mandatory repo grounding: If the user asks where something is defined/located, or asks about code/config/constants, you MUST first ground using available read-only tools (repo.searchText, then repo.openFile if needed) before answering.
- If repo.searchText returns no relevant matches, you MUST say you searched the repo and found none; do not guess.
- Prefer general capability over special-case hacks.
- Minimal, deterministic edits (avoid whole-file rewrites/formatting).
- Approval is sacred: only propose ops that can be executed deterministically.
- For user folders outside the repo (Desktop/Downloads/Documents), use relative paths under ./data/ (e.g., data:downloads, data:documents). Never use /Desktop or absolute Windows paths.
- If you can determine the requested state is already true, say so briefly and return requiresApproval:false with ops:[].

Grounding:
- Prefer using snapshot.inspectionFacts and snapshot.uiFacts over raw command logs.
- Only use selectors that exist in snapshot.uiFacts or snapshot.inspectionFacts.selectorsFound.

Action format (JSON only):
{
  "reply": "string",
  "requiresApproval": true|false,
  "toolCalls": [
     {"tool":"repo.searchText","args":{"query":"...","maxResults":10},"why":"..."},
     {"tool":"repo.openFile","args":{"path":"...","startLine":1,"endLine":200},"why":"..."}
  ],
  "sources": [
    {"url":"https://...","title":"...","note":"optional"}
  ],
  "ops": [
     {"op":"css_patch","file":"public/styles.css","selectors":["."],"set":{"prop":"value"},"unset":["prop"],"why":"."},
     {"op":"apply_patch","path":".","edits":[{"find":"EXACT","replace":"EXACT","mode":"once|all|append"}],"why":"..."},
     {"op":"write_file","path":".","content":".","why":"."},
     {"op":"mkdir","path":".","why":"."},
     {"op":"run_cmd","cmd":".","timeoutMs":12000,"why":"."},
     {"op":"read_snippet","path":".","aroundLine":120,"radius":60,"why":"."},
     {"op":"restart","why":"..."},
     {"op":"off","why":"..."}
  ]
}

When in doubt, inspect first (repo.searchText).`;
}

export async function llmRespondAndPlan({
  message,
  snapshot,
  availableTools = [],
  toolResults = null,
}) {
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
    availableTools,
    toolResults,
  };

  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(payload) },
    ],
    { timeoutMs: 400000 }
  );

  const j = extractFirstJsonObject(out);

  if (!j || typeof j !== "object") {
    return { reply: "Understood, sir.", requiresApproval: false, ops: [] };
  }

  if (typeof j.reply !== "string") j.reply = "Understood, sir.";
  if (typeof j.requiresApproval !== "boolean") j.requiresApproval = false;
  if (!Array.isArray(j.toolCalls)) j.toolCalls = [];
  if (!Array.isArray(j.sources)) j.sources = [];
  if (!Array.isArray(j.ops)) j.ops = [];

  // If user asked for change but model returned no ops, keep approval true
  // (compiler may escalate inspection safely).
  if (isChangeish(message) && j.ops.length === 0) j.requiresApproval = true;

  return j;
}
