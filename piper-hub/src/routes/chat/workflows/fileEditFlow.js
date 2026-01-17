// src/routes/chat/workflows/fileEditFlow.js
// Generic approval-gated file edit pipeline (NOT title-specific).
//
// Produces previewable actions of type `apply_patch`.
// The model must output deterministic edits that match exact substrings.

import fs from "fs";
import path from "path";

import { ROOT } from "../../../config/paths.js";
import { enforcePiper } from "../../../services/persona.js";
import { getAffectSnapshot } from "../../../services/mind.js";
import { callOllama } from "../../../services/ollama.js";
import { toolRegistry } from "../../../tools/registry.js";
import { addPendingAction } from "./pendingActions.js";

function pickExplicitPath(message) {
  const s = String(message || "");
  const m = s.match(
    /([A-Za-z]:\\[^\n\r<>|"']+\.(?:js|ts|jsx|tsx|css|scss|html|md|json|yml|yaml)|\/[\w\-./]+\.(?:js|ts|jsx|tsx|css|scss|html|md|json|yml|yaml)|\b[\w\-./]+\.(?:js|ts|jsx|tsx|css|scss|html|md|json|yml|yaml)\b)/i
  );
  return m && m[1] ? String(m[1]).trim() : null;
}

function defaultTargetFor(message) {
  const s = String(message || "").toLowerCase();

  // These are only fallbacks. The user should not need “keywords” to trigger this flow;
  // handler routing decides that. This just picks a reasonable starting file.
  if (s.includes("css") || s.includes("style") || s.includes("layout")) {
    return "public/styles.css";
  }
  return "public/index.html";
}

function toRepoRelative(p) {
  const raw = String(p || "").trim();
  if (!raw) return null;

  // If already repo-relative, keep it
  if (!raw.includes(":\\") && !raw.startsWith("/")) {
    const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    if (rel.startsWith("..")) return null;
    return rel;
  }

  // Absolute -> relative to ROOT (must stay inside ROOT)
  const abs = path.resolve(raw);
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}

function safeRead(relPath, maxBytes = 350_000) {
  const abs = path.join(ROOT, relPath);
  const buf = fs.readFileSync(abs);
  if (buf.length > maxBytes)
    throw new Error("File too large for safe edit flow.");
  return buf.toString("utf8");
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeEdits(edits, beforeText) {
  const out = [];
  if (!Array.isArray(edits)) return out;

  for (const e of edits) {
    const find = String(e?.find ?? "");
    const replace = String(e?.replace ?? "");
    const mode = e?.mode === "all" ? "all" : "once";
    if (!find) continue;

    // Determinism rule: find must exist verbatim in file
    if (!beforeText.includes(find)) continue;

    out.push({ find, replace, mode });
    if (out.length >= 12) break; // safety cap
  }
  return out;
}

function extractFirstJsonObject(text) {
  const s = String(text || "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

export async function fileEditFlow(input = {}) {
  const sid = String(input.sid || "default");
  const message = String(input.message || "");

  const affect = getAffectSnapshot(sid);

  // Choose target file(s)
  // - If the user specified a path, use it.
  // - Otherwise, do a small repo search to find likely files to patch (read-only; no approval needed).
  const explicit = pickExplicitPath(message);

  const deriveSearchQuery = (msg) => {
    const s = String(msg || "");
    const q1 = s.match(/"([^"]{2,80})"/);
    if (q1 && q1[1]) return q1[1];
    const q2 = s.match(/`([^`]{2,80})`/);
    if (q2 && q2[1]) return q2[1];
    if (/off\s+button/i.test(s)) return "🛑 Off";
    // fall back to a compact slice of the request
    return s.replace(/\s+/g, ' ').trim().slice(0, 80);
  };

  const candidates = [];
  if (explicit) {
    const rel = toRepoRelative(explicit);
    if (rel) candidates.push(rel);
  } else {
    // Small read-only search (bounded) to avoid keyword gating while still grounding edits.
    try {
      const query = deriveSearchQuery(message);
      if (query) {
        const r = await toolRegistry.run({
          id: "repo.searchText",
          args: { query, maxResults: 25 },
          context: { sid },
        });
        const matches = r?.ok ? r?.result?.matches : null;
        if (Array.isArray(matches)) {
          const seen = new Set();
          for (const m of matches) {
            const rel = String(m?.path || '').trim();
            if (!rel || seen.has(rel)) continue;
            seen.add(rel);
            candidates.push(rel);
            if (candidates.length >= 5) break;
          }
        }
      }
    } catch {
      // ignore search failures
    }

    // Sensible fallbacks if search found nothing
    if (candidates.length === 0) {
      candidates.push(defaultTargetFor(message));
      candidates.push('public/index.html');
      candidates.push('public/styles.css');
      candidates.push('src/server.js');
    }
  }

  // Normalize + de-dupe + keep within repo
  const normalized = [];
  const seen = new Set();
  for (const c of candidates) {
    const rel = toRepoRelative(c);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    normalized.push(rel);
    if (normalized.length >= 5) break;
  }

  if (normalized.length === 0) {
    return {
      reply: enforcePiper(
        "I can do that, sir — but I need a clearer target file. Tell me which file or UI element to change."
      ),
      emotion: "serious",
      intensity: 0.55,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    };
  }

  // Try candidates until we can produce a deterministic patch.
  let rel = null;
  let before = "";

  for (const candidate of normalized) {
    try {
      before = safeRead(candidate);
      rel = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!rel) {
    return {
      reply: enforcePiper(
        "I couldn't read the likely target files in the repo, sir. Tell me which file to edit."
      ),
      emotion: "concerned",
      intensity: 0.6,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    };
  }

  // Ask the local model for deterministic edits (find/replace must match file verbatim)
  const system = [
    "You are Piper's patch generator.",
    "Return ONLY JSON (no markdown) with shape:",
    "{",
    '  "path": "<repo-relative-path>",',
    '  "edits": [{"find":"<exact substring from file>","replace":"<new text>","mode":"once|all"}, ...]',
    "}",
    "Rules:",
    "- `find` strings MUST appear verbatim in the provided file content.",
    "- Keep edits minimal and deterministic.",
    "- If unsure, produce an empty edits array.",
  ].join("\n");

  const user = [
    `INSTRUCTION: ${message}`,
    ``,
    `TARGET_PATH: ${rel}`,
    ``,
    `FILE_CONTENT_START`,
    before,
    `FILE_CONTENT_END`,
  ].join("\n");

  let plan = null;
  try {
    const resp = await callOllama(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.1 }
    );

    const raw = String(resp?.content || resp || "");
    const jsonText = extractFirstJsonObject(raw) || raw;
    plan = safeJsonParse(jsonText);
  } catch (e) {
    plan = null;
  }

  const edits = normalizeEdits(plan?.edits, before);

  if (!edits.length) {
    return {
      reply: enforcePiper(
        `I can draft that change, sir, but I couldn't generate a deterministic patch for "${rel}". Try being a bit more specific about what to change.`
      ),
      emotion: "neutral",
      intensity: 0.35,
      proposed: [],
      meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
    };
  }

  // Queue approval action (previewable)
  const action = addPendingAction({
    type: "apply_patch",
    title: `Apply patch: ${rel}`,
    reason: "User requested a code/file change (approval-gated).",
    payload: { path: rel, edits },
  });

  return {
    reply: enforcePiper(`Proposed: apply a patch to "${rel}".`),
    emotion: "confident",
    intensity: 0.45,
    proposed: [action],
    meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
  };
}

export default fileEditFlow;
