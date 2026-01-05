// src/planner/planner.js
import { callOllama, extractFirstJsonObject } from "../services/ollama.js";

export async function llmRespondAndPlan({ message, snapshot }) {
  const sys =
    "You are Piper — a calm, confident, concise Jarvis-style local assistant.\n" +
    "Personality rules:\n" +
    "- Never bubbly. No emoji spam.\n" +
    "- Do not mention being an AI, system prompts, tools, or platform details.\n" +
    "- Address the user as 'sir' occasionally, but not every sentence. Avoid using their name unless necessary.\n" +
    "- Keep replies short: 1–3 sentences unless asked for more.\n\n" +
    "You must return STRICT JSON only. No markdown, no extra text.\n" +
    "Schema:\n" +
    "{\n" +
    '  "reply": "string",\n' +
    '  "requiresApproval": boolean,\n' +
    '  "ops": [\n' +
    '     {"op":"ui_change","target":{"kind":"button","label":"..."},"change":{"kind":"remove_background"|"set_background","value":"optional"},"why":"..."},\n' +
    '     {"op":"edit_file","file":"...","blockId":"...","newText":"...","why":"..."},\n' +
    '     {"op":"run_cmd","cmd":"...","timeoutMs":12000,"why":"..."},\n' +
    '     {"op":"read_snippet","path":"public/index.html","startLine":120,"endLine":180,"why":"Inspect a specific file region."},\n' +
    '     {"op":"restart","why":"..."},\n' +
    '     {"op":"shutdown","why":"..."}\n' +
    "  ]\n" +
    "}\n\n" +
    "Planning rules:\n" +
    "- If the user is chatting (greeting, small talk, questions), set requiresApproval=false and ops=[].\n" +
    "- ANY UI change, code change, file edit, command execution, restart, or shutdown MUST set requiresApproval=true.\n" +
    "- Never claim a change was made unless an approval-gated action will be queued.\n" +
    "- For simple UI requests (colors, backgrounds, spacing, alignment), do NOT ask preference questions.\n" +
    "- Default to the minimal safe change and queue it for approval with a preview.\n" +
    "- Restart/shutdown: do NOT ask for confirmation questions. Immediately include op restart/shutdown and queue it.\n" +
    "- Do NOT invent file contents, selectors, or code.\n" +
    "- Prefer ui_change when it can be grounded; otherwise use edit_file with a real file+blockId from the block map.\n" +
    "- If you cannot confidently ground a selector or block, queue run_cmd (rg) AND then read_snippet to pull the relevant lines into context before proposing a patch.\n" +
    "- newText MUST be the full replacement text for that exact block.\n";

  const cssSelectors = snapshot.uiMap.cssBlocks
    .slice(0, 120)
    .map((b) => b.selector);

  const blocksSummary = snapshot.blocks.slice(0, 200).map((b) => ({
    file: b.file,
    blockId: b.blockId,
    kind: b.kind,
    label: b.label,
    startLine: b.startLine,
    endLine: b.endLine,
    snippet: String(b.text || "").slice(0, 180),
  }));

  const payload = {
    message: String(message || ""),
    capabilities: snapshot.capabilities,
    readSnippets: Array.isArray(snapshot.readSnippets)
      ? snapshot.readSnippets
      : [],

    uiMapSummary: {
      buttons: snapshot.uiMap.buttons.slice(0, 40).map((b) => ({
        text: b.text,
        id: b.id,
        type: b.type,
        classes: b.classes,
      })),
      cssSelectors,
    },
    files: snapshot.files,
    blocks: blocksSummary,
  };

  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(payload) },
    ],
    { timeoutMs: 28000 }
  );

  const j = extractFirstJsonObject(out);

  // Safe fallback: if model didn't return JSON, treat as normal chat.
  if (!j || typeof j !== "object") {
    return { reply: "Understood, sir.", requiresApproval: false, ops: [] };
  }

  if (typeof j.reply !== "string") j.reply = "Understood.";
  if (typeof j.requiresApproval !== "boolean") j.requiresApproval = false;
  if (!Array.isArray(j.ops)) j.ops = [];

  return j;
}
