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
    "- Approval is sacred: only propose ops that can be executed deterministically.\n\n" +
    "Action format (JSON only):\n" +
    "{\n" +
    '  "reply": "string",\n' +
    '  "requiresApproval": true|false,\n' +
    '  "ops": [\n' +
    '     {"op":"css_patch","file":"public/styles.css","selectors":["."],"set":{"prop":"value"},"unset":["prop"],"why":"."},\n' +
    '     {"op":"apply_patch","path":".","edits":[{"find":"EXACT","replace":"EXACT","mode":"once"}],"why":"..."},\n' +
    '     {"op":"write_file","path":".","content":".","why":"."},\n' +
    '     {"op":"mkdir","path":".","why":"."},\n' +
    '     {"op":"run_cmd","cmd":".","timeoutMs":12000,"why":"."},\n' +
    '     {"op":"restart","why":"..."},\n' +
    '     {"op":"off","why":"..."}\n' +
    "  ]\n" +
    "}\n"
  );
}

function hasSelector(snapshot, sel) {
  const s = String(sel || "").trim();
  if (!s) return false;

  const uiSelectors = Array.isArray(snapshot?.uiMapSummary?.cssSelectors)
    ? snapshot.uiMapSummary.cssSelectors
    : [];
  if (uiSelectors.includes(s)) return true;

  const snippets = Array.isArray(snapshot?.readSnippets)
    ? snapshot.readSnippets
    : [];
  for (const sn of snippets) {
    const txt = String(sn?.stdout || sn?.text || "");
    if (txt.includes(s)) return true;
  }

  const runs = Array.isArray(snapshot?.runCmdOutputs)
    ? snapshot.runCmdOutputs
    : [];
  for (const r of runs) {
    const out = String(r?.stdout || "");
    if (out.includes(s)) return true;
  }

  const raw = snapshot?.rawFiles || {};
  for (const k of Object.keys(raw)) {
    if (String(raw[k] || "").includes(s)) return true;
  }

  return false;
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

  const runCmdOutputs = Array.isArray(snapshot.runCmdOutputs)
    ? snapshot.runCmdOutputs
    : [];
  const readSnippets = Array.isArray(snapshot.readSnippets)
    ? snapshot.readSnippets
    : [];

  // --- Grounded deterministic fallback for docking ---
  if (looksLikeDockPendingActions(message)) {
    const groundedHasActionsWrap = hasSelector(snapshot, "#actionsWrap");
    if (groundedHasActionsWrap) {
      return {
        reply:
          "Understood. I found #actionsWrap and can dock Pending Actions below the chat panel by moving it to the chat column.",
        requiresApproval: true,
        ops: [
          {
            op: "css_patch",
            file: "public/styles.css",
            selectors: ["#actionsWrap"],
            set: { "grid-column": "1" },
            unset: [],
            why: "Dock Pending Actions below the chat box by placing #actionsWrap in the chat column (column 1) instead of the right-side column.",
          },
        ],
      };
    }

    return {
      reply:
        "I can do that, but I don’t yet have a grounded selector for the Pending Actions container. I’ll inspect the relevant HTML/CSS next.",
      requiresApproval: true,
      ops: [
        {
          op: "run_cmd",
          cmd: 'rg -n "<title>|Pending Actions|Recent Actions|actionsWrap|historyList|actionsList|id=\\"actionsWrap\\"" public/index.html public/styles.css src',
          timeoutMs: 12000,
          why: "Locate grounded selectors and layout rules for the Pending Actions panel.",
        },
      ],
    };
  }

  let sys = sysPrompt();

  if (isChangeish(message)) {
    sys +=
      "\nUI/layout change detected.\n" +
      "- Prefer css_patch on public/styles.css.\n" +
      "- Use selectors that exist in snippets/raw files.\n" +
      "- Avoid reformatting; only set/unset needed properties.\n" +
      "- If unsure, request inspection with run_cmd.\n";
  }

  const payload = {
    message: String(message || ""),
    capabilities: snapshot.capabilities,
    uiMapSummary: snapshot.uiMapSummary,
    runCmdOutputs,
    readSnippets,
    allowlistedFiles: snapshot.allowlistedFiles || [],
  };

  // callOllama expects ARRAY of {role, content}
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

  // If user asked for change but model returned no ops, keep approval true (compiler will fallback/inspect)
  if (isChangeish(message) && j.ops.length === 0) j.requiresApproval = true;

  return j;
}
