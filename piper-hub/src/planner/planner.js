// src/planner/planner.js
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";

function isChangeish(message) {
  const m = String(message || "").toLowerCase();
  return /dock|move|layout|ui|css|style|position|below|under|bottom|beneath|above|left|right|center|max-?width|overflow|scroll|fix|resize|panel|sidebar|create file|write file|create folder|make folder|mkdir|document|downloads|desktop|documents/i.test(
    m
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
    "- Approval is sacred: only propose ops that can be executed deterministically.\n\n" +
    "PATH RULES (CRITICAL):\n" +
    "- Default paths are repo-relative (inside the Piper repo).\n" +
    "- For user folders outside the repo, you MUST use the allowlisted scheme:\n" +
    "    known:downloads/<relative path>\n" +
    "    known:desktop/<relative path>\n" +
    "    known:documents/<relative path>\n" +
    "- Never output absolute paths like C:\\\\... or /Users/... . Use known:...\n\n" +
    "Action format (JSON only):\n" +
    "{\n" +
    '  "reply": "string",\n' +
    '  "requiresApproval": true|false,\n' +
    '  "ops": [\n' +
    '     {"op":"css_patch","file":"public/styles.css","selectors":["."],"set":{"prop":"value"},"unset":["prop"],"why":"."},\n' +
    '     {"op":"apply_patch","path":".","find":"EXACT","replace":"EXACT","why":"."},\n' +
    '     {"op":"write_file","path":".","content":".","why":"."},\n' +
    '     {"op":"mkdir","path":"known:downloads/some/folder","why":"."},\n' +
    '     {"op":"run_cmd","cmd":".","timeoutMs":12000,"why":"."}\n' +
    "  ]\n" +
    "}\n\n" +
    "Hard guidance:\n" +
    "- If user asks to CHANGE something: requiresApproval MUST be true and ops MUST contain the change.\n" +
    "- If user asks only to LOOK / LOCATE: requiresApproval MUST be false and ops MUST be empty.\n" +
    "- Prefer returning ONE op per request when feasible.\n" +
    "- If you can do it with a single css_patch, do that.\n" +
    "- If multiple steps are truly required, keep ops minimal; bundling is handled downstream.\n"
  );
}

export async function llmRespondAndPlan({ message, snapshot }) {
  const runCmdOutputs = Array.isArray(snapshot.runCmdOutputs)
    ? snapshot.runCmdOutputs
    : [];
  const readSnippets = Array.isArray(snapshot.readSnippets)
    ? snapshot.readSnippets
    : [];

  let sys = sysPrompt();

  // If this is a UI/layout change, force grounding with available data.
  const changeish = isChangeish(message);
  if (changeish) {
    sys +=
      "\nGrounding hints:\n" +
      "- If you need selectors or file locations, rely on snapshot.rankedMatches/readSnippets/runCmdOutputs.\n" +
      "- If not enough grounding exists, choose requiresApproval=false and ask to inspect.\n";
  }

  const userPayload = {
    message: String(message || ""),
    // Keep these small-ish; they are hints, not the full repo.
    rankedMatches: snapshot?.rankedMatches || [],
    runCmdOutputs,
    readSnippets,
  };

  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    { timeoutMs: 60000 }
  );

  const j = extractFirstJsonObject(out);

  if (!j || typeof j !== "object") {
    return {
      reply:
        "Sir, I couldn't produce a grounded plan from that. If you want, tell me what file or UI element to inspect first.",
      requiresApproval: false,
      ops: [],
    };
  }

  // Normalize
  return {
    reply: String(j.reply || "Understood, sir."),
    requiresApproval: Boolean(j.requiresApproval),
    ops: Array.isArray(j.ops) ? j.ops : [],
  };
}
