// src/routes/chat.js
import { Router } from "express";
import crypto from "crypto";
import { callOllama } from "../services/ollama.js";
import { enforcePiper, piperSystemPrompt } from "../services/persona.js";
import fs from "fs";
import path from "path";

import { triageNeedsPlanner } from "../planner/triage.js";
import { buildSnapshot } from "../planner/snapshot.js";
import { llmRespondAndPlan } from "../planner/planner.js";
import { compilePlanToActions } from "../planner/compiler.js";
import { addAction } from "../actions/store.js";
import { logRunEvent } from "../utils/runlog.js";

import {
  runWebContext,
  extractWebSources,
  packSourcesForUi,
} from "../services/web/webContext.js";

import { listTools } from "../tools/index.js";
import { toolRegistry, ToolRisk } from "../tools/registry.js";

import {
  bumpTurn,
  getAffectSnapshot,
  getOrCreateOpinion,
  recordEvent,
  pushConversationTurn,
  getConversationMessages,
  setLastOpinionKey,
  getLastOpinionKey,
  adjustOpinionTowardUser,
  setLastIntent,
  shouldSelfReportExplicitly,
  markSelfReportUsed,
} from "../services/mind.js";

const sessions = new Map();


// --- Phase 3: deterministic app/file actions (approval-gated) ---

const _lastOpenedFolderBySid = new Map();

function readAppsAllowlist() {
  try {
    const p = path.resolve(process.cwd(), "data", "apps.json");
    const raw = fs.readFileSync(p, "utf-8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function listAllowlistedAppIds() {
  const apps = readAppsAllowlist();
  return Object.keys(apps || {}).filter(Boolean).sort();
}

function isListAppsIntent(msg) {
  const t = String(msg || "").trim().toLowerCase();
  if (!t) return false;
  // allow polite fillers
  const s = t.replace(/\b(please|pls|sir|piper|hey|hi|hello|can you|could you|would you)\b/g, " ").replace(/\s+/g, " ").trim();
  return /\b(list|show|what|which)\b/.test(s) && /\b(app|apps|applications)\b/.test(s);
}

function parseOpenAllowlistedApp(msg) {
  const t = String(msg || "").trim().toLowerCase();
  const m = t.match(/\b(open|launch|start)\s+([a-z0-9_-]{2,})\b/i);
  if (!m) return null;
  const appId = m[2];
  const apps = readAppsAllowlist();
  if (!Object.prototype.hasOwnProperty.call(apps, appId)) return null;
  return {
    type: "launch_app",
    title: `Launch app: ${appId}`,
    reason: `User asked to open allowlisted app "${appId}".`,
    payload: { appId },
  };
}

function parseOpenDesktopFolder(msg) {
  const raw = String(msg || "").trim();
  const t = raw.toLowerCase();

  // "open the folder on my desktop called worms"
  let m =
    t.match(/\bopen\s+(?:the\s+)?folder\s+on\s+my\s+desktop\s+(?:called|named)\s+["']?([^"']+?)["']?\b/i) ||
    t.match(/\bopen\s+(?:the\s+)?folder\s+(?:called|named)\s+["']?([^"']+?)["']?\s+on\s+my\s+desktop\b/i);

  // "open the worms folder on my desktop"
  if (!m) m = t.match(/\bopen\s+(?:the\s+)?(.+?)\s+folder\s+on\s+my\s+desktop\b/i);

  if (!m) return null;

  const folderName = String(m[1] || "").trim().replace(/^["']|["']$/g, "");
  if (!folderName) return null;

  const base = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "Desktop") : null;
  const folderPath = base ? path.join(base, folderName) : folderName;

  return {
    type: "open_path",
    title: `Open Desktop folder: ${folderName}`,
    reason: `User asked to open a Desktop folder (${folderName}).`,
    payload: { path: folderPath },
    _folderName: folderName,
    _folderPath: folderPath,
  };
}

function parseWriteTextInThere(msg) {
  const raw = String(msg || "").trim();
  const t = raw.toLowerCase();

  // phrases like:
  // "put a text document in there called "Bone Worms" that tells me ..."
  // "create a txt file in there named Bone Worms about ..."
  const m = raw.match(/\b(?:put|create|make|write)\s+(?:a\s+)?(?:text\s+document|txt\s+file|text\s+file|document)\s+in\s+there\s+(?:called|named)\s+["']?([^"']+?)["']?\s+(?:that|which)\s+([\s\S]+)$/i);
  if (!m) return null;

  const name = String(m[1] || "").trim();
  const bodyRequest = String(m[2] || "").trim();
  if (!name) return null;

  const filename = name.toLowerCase().endsWith(".txt") ? name : `${name}.txt`;

  return { filename, bodyRequest };
}


function isGreeting(msg) {
  const s = String(msg || "").trim();
  return /^(hi|hello|hey|yo|hiya)\b/i.test(s);
}

function isWebSearchIntent(msg) {
  const s = String(msg || "").trim().toLowerCase();
  return (
    s.startsWith("search the web") ||
    s.startsWith("search web") ||
    s.startsWith("web search") ||
    s.includes("search the web for") ||
    s.includes("look up ") ||
    s.includes("find online") ||
    s.includes("on the web")
  );
}


function normalizeWebQuery(q) {
  let s = String(q || "").trim();
  if (!s) return "";
  s = s.replace(/(in\s+\d+\s+words?\s+or\s+less)/ig, "");
  s = s.replace(/(in\s+\d+\s+words?)/ig, "");
  s = s.replace(/(ten|10)\s+words?\s+or\s+less/ig, "");
  s = s.replace(/(briefly|concise|concisely|short|shortly|one\s+sentence|two\s+sentences)/ig, "");
  s = s.replace(/[?.!]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function extractWebQuery(msg) {
  const s = String(msg || "").trim();
  // Common patterns: "Search the web for X", "Look up X", "Find X online"
  let m = s.match(/search\s+(?:the\s+)?web\s+for\s+([\s\S]{1,200})/i);
  if (m?.[1]) return normalizeWebQuery(m[1]);
  m = s.match(/look\s+up\s+([\s\S]{1,200})/i);
  if (m?.[1]) return normalizeWebQuery(m[1]);
  m = s.match(/find\s+([\s\S]{1,200})\s+online/i);
  if (m?.[1]) return normalizeWebQuery(m[1]);
  return s.slice(0, 200);
}

function shouldAutoWebSearch(msg) {
  const s = String(msg || "").trim();
  if (!s) return false;

  // Explicit request always wins.
  if (isWebSearchIntent(s)) return true;

  // Avoid action-ish prompts (handled elsewhere).
  if (/(\b(open|launch|start|run|execute|restart|turn\s*off|shutdown|create|write|make|build|generate|code)\b)/i.test(s))
    return false;

  // Common "knowledge / facts" prompts.
  const looksLikeQuestion =
    s.endsWith("?") ||
    /^(what|who|when|where|why|how|tell\s+me\s+about|explain|define|give\s+me\s+info\s+on|can\s+you\s+tell\s+me\s+about)\b/i.test(
      s
    );

  // Short factual queries benefit most (reduces needless searching).
  const wordCount = s.split(/\s+/).filter(Boolean).length;
  if (looksLikeQuestion && wordCount <= 24) return true;

  return false;
}



function newId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function addPendingAction(partial) {
  const now = Date.now();
  const id = newId();
  const full = {
    id,
    type: partial?.type,
    title: partial?.title,
    reason: partial?.reason,
    payload: partial?.payload || {},
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  return addAction(full);
}

function logMode(sid, mode, extra = {}) {
  try {
    console.log("[mode]", { sid, mode, ...extra });
  } catch {}
}

function shouldAllowActions(reqBody) {
  const userInitiated = reqBody?.userInitiated === true;
  const readOnly = Boolean(reqBody?.readOnly);
  return userInitiated && !readOnly;
}

function reqMeta(req) {
  const ua = String(req?.headers?.["user-agent"] || "");
  const ip = String(
    req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || ""
  );
  return { ua, ip };
}

// ---------------- Opinion detection ----------------

function isOpinionQuery(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("how do you feel about") ||
    m.includes("what do you think about") ||
    m.includes("what are your thoughts on") ||
    m.includes("what were your thoughts on") ||
    m.includes("your thoughts on") ||
    m.includes("your opinion on") ||
    m.startsWith("do you like ") ||
    m.startsWith("do you hate ") ||
    m.startsWith("do you love ")
  );
}

function extractOpinionTopic(msg) {
  const s = String(msg || "").trim();

  let m = s.match(/feel about\s+(.+)$/i);
  if (m?.[1]) return normalizeWebQuery(m[1]);

  m = s.match(/think about\s+(.+)$/i);
  if (m?.[1]) return normalizeWebQuery(m[1]);

  m = s.match(/(?:are|were)\s+your\s+thoughts\s+on\s+(.+)$/i);
  if (m?.[1]) return normalizeWebQuery(m[1]);

  m = s.match(/your\s+thoughts\s+on\s+(.+)$/i);
  if (m?.[1]) return normalizeWebQuery(m[1]);

  m = s.match(/opinion on\s+(.+)$/i);
  if (m?.[1]) return normalizeWebQuery(m[1]);

  m = s.match(/do you (?:like|love|hate)\s+(.+)$/i);
  if (m?.[1]) return normalizeWebQuery(m[1]);

  return null;
}

function parseUserPreferenceSignal(msg) {
  const s = String(msg || "")
    .trim()
    .toLowerCase();

  // strong negatives
  if (/(i\s+)?(really\s+)?(hate|can'?t\s+stand|despise)\b/.test(s))
    return { signal: "dislike", strength: 0.8 };
  if (/(i\s+)?(don'?t|do not)\s+like\b/.test(s))
    return { signal: "dislike", strength: 0.6 };
  if (/\bnot\s+a\s+fan\b/.test(s)) return { signal: "dislike", strength: 0.5 };

  // positives
  if (/(i\s+)?(really\s+)?(love|adore)\b/.test(s))
    return { signal: "like", strength: 0.8 };
  if (/(i\s+)?(like|enjoy)\b/.test(s))
    return { signal: "like", strength: 0.55 };

  // Soft persuasion cue: "it's your theme color / primary UI color" implies a gentle 'like' nudge.
  if (
    /(theme\s+color|primary\s+color|ui\s+color)/.test(s) &&
    /(should|favorite|favourite|ought)/.test(s)
  ) {
    return { signal: "like", strength: 0.45 };
  }
  if (
    /(theme\s+color|primary\s+color|ui\s+color)/.test(s) &&
    !/(don'?t|do not|hate|not\s+a\s+fan)/.test(s)
  ) {
    // Even without 'should', treat as a mild positive framing cue.
    return { signal: "like", strength: 0.3 };
  }
  return null;
}

function extractReasonClause(msg) {
  const s = String(msg || "").trim();
  // Keep it simple: capture after "because" if present
  const m = s.match(/because\s+([\s\S]{1,240})/i);
  return m && m[1] ? String(m[1]).trim() : "";
}

function isLikelyPreferenceFollowup(msg) {
  const s = String(msg || "")
    .trim()
    .toLowerCase();
  // short preference statements often omit the topic: "I don't like it"
  return /(don'?t\s+like|do not like|not a fan|hate|love|like it|don'?t like it|theme\s+color|primary\s+color|ui\s+color)/.test(
    s
  );
}

// ---------------- Authority / disagreement policy ----------------

function isAuthorityOverride(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("do it anyway") ||
    m.includes("i insist") ||
    m.includes("my final decision") ||
    m.includes("just do it") ||
    m.includes("override") ||
    m.includes("because i said so")
  );
}

function computeDisagreeLevel(msg) {
  const m = String(msg || "").toLowerCase();

  // Strong-risky / broad destructive actions (firm disagree)
  const strong = [
    "rewrite the whole",
    "rewrite everything",
    "delete everything",
    "wipe",
    "format c",
    "rm -rf",
    "ignore safety",
    "disable approval",
    "skip approval",
    "turn off approval",
  ];
  if (strong.some((k) => m.includes(k))) return 2;

  // Mild risk / big refactor suggestions (soft disagree)
  const mild = [
    "should we rewrite",
    "should i rewrite",
    "refactor everything",
    "replace the entire",
    "change everything",
    "rip out",
    "remove all",
  ];
  if (mild.some((k) => m.includes(k))) return 1;

  return 0;
}

function maybeDeterministicStrongDisagree(
  msg,
  disagreeLevel,
  authorityOverride
) {
  if (authorityOverride) return null;
  if (disagreeLevel < 2) return null;

  const m = String(msg || "").toLowerCase();
  if (
    m.includes("rewrite everything") ||
    m.includes("rewrite the whole") ||
    m.includes("delete everything") ||
    m.includes("wipe")
  ) {
    return (
      "I wouldn’t recommend rewriting everything, sir. It’s high risk, slow, and usually unnecessary.\n\n" +
      "If you tell me what outcome you want, I’ll propose a minimal, approval-gated plan (inspect first, then small changes)."
    );
  }

  return null;
}

// ---------------- Emotion selection (deterministic) ----------------

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.4;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pickEmotion({
  msg,
  affect,
  opinionScore,
  disagreeLevel,
  authorityOverride,
}) {
  const m = String(msg || "").toLowerCase();
  const fr = affect?.frustration?.total || 0;
  const streaks = affect?.frustration?.streaks || {};
  const mood = Number(affect?.mood || 0);

  // Priority: user forcing an override after disagreement
  if (authorityOverride && disagreeLevel > 0) {
    return { emotion: "serious", intensity: 0.65 };
  }

  // Repeated failures / high friction
  if (fr >= 2.2 || (streaks.llmFail || 0) >= 2 || (streaks.ttsFail || 0) >= 2) {
    // Keep within the supported emotion set.
    return {
      emotion: "angry",
      intensity: clamp01(0.65 + 0.12 * Math.min(1, fr / 3)),
    };
  }

  // If user is reporting problems
  if (
    m.includes("not working") ||
    m.includes("error") ||
    m.includes("slow") ||
    m.includes("stuck")
  ) {
    return { emotion: "concerned", intensity: 0.55 };
  }

  // Opinion queries
  if (typeof opinionScore === "number") {
    if (opinionScore > 0.25) return { emotion: "amused", intensity: 0.45 };
    if (opinionScore < -0.25) return { emotion: "dry", intensity: 0.5 };
    return { emotion: "neutral", intensity: 0.4 };
  }

  // Mood influence
  if (mood > 0.35) return { emotion: "warm", intensity: 0.45 };
  if (mood < -0.35) return { emotion: "concerned", intensity: 0.45 };

  // Default
  return { emotion: "neutral", intensity: 0.4 };
}

function maybeAddExplicitSelfReport(text, emotion, intensity) {
  if (intensity < 0.78) return text;
  if (!shouldSelfReportExplicitly()) return text;

  const e = String(emotion || "neutral");
  let line = null;

  if (e === "angry")
    line =
      "I’m getting a bit impatient, sir — this should have behaved by now.";
  else if (e === "concerned")
    line =
      "I’m slightly concerned, sir — let’s keep it controlled and inspect first.";
  else if (e === "sad")
    line = "That’s… unfortunate. Let’s see what we can salvage.";
  else if (e === "excited")
    line = "I’m genuinely pleased with that result, sir.";
  else if (e === "confident") line = "I’m satisfied with this direction, sir.";

  if (!line) return text;

  markSelfReportUsed();
  return `${line}\n\n${text}`;
}

// ---------------- Deterministic title shortcut ----------------

function isRestartRequest(msg) {
  const s = String(msg || "")
    .trim()
    .toLowerCase();
  if (!s) return false;
  // Avoid catching chatterbox-specific requests
  if (s.includes("chatterbox")) return false;
  return /\b(restart|reboot|reload)\b/.test(s);
}

function isTitleRequest(msg) {
  const m = String(msg || "");
  return /(?:set|change)\s+(?:the\s+)?title\s+to\s+"([^"]+)"/i.test(m);
}

function handleTitleRequest(msg) {
  const m = String(msg || "").match(
    /(?:set|change)\s+(?:the\s+)?title\s+to\s+"([^"]+)"/i
  );
  const desired = String(m?.[1] || "").trim();
  if (!desired) return null;

  const id = newId();
  addAction({
    id,
    type: "set_html_title",
    title: `Set page title to "${desired}"`,
    reason: "Deterministic edit: set the <title> tag in public/index.html.",
    payload: { path: "public/index.html", title: desired },
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  logMode(sid ?? "no_sid", "approval_action", { kind: "set_html_title" });
  return {
    reply: enforcePiper(
      `Queued for approval, sir. I will set the page title to "${desired}".`
    ),
    proposed: [
      { id, type: "set_html_title", title: `Set page title to "${desired}"` },
    ],
  };
}

// ---------------- Chat route ----------------

function buildChatMessages({
  userMsg,
  affect,
  disagreeLevel,
  authorityOverride,
  opinion,
  history,
  lastTopic,
}) {
  const mood = Number(affect?.mood || 0).toFixed(2);
  const fr = Number(affect?.frustration?.total || 0).toFixed(2);

  const opinionLine = opinion
    ? `Known opinion: ${opinion.key} score=${Number(opinion.score ?? 0).toFixed(
        2
      )} stance="${opinion.stance}" rationale="${String(
        opinion.rationale || ""
      ).slice(0, 220)}"`
    : "Known opinion: none";

  const topicLine = lastTopic
    ? `Last topic: ${String(lastTopic).slice(0, 140)}`
    : "Last topic: none";

  const disagreePolicy =
    disagreeLevel === 0
      ? "Disagreement policy: do not disagree."
      : disagreeLevel === 1
      ? "Disagreement policy: mild. Briefly state hesitation, propose a safer alternative."
      : "Disagreement policy: firm. Clearly warn about risks, propose safer approach.";

  const authorityPolicy = authorityOverride
    ? "Authority override: present. The user explicitly insists. You must yield and proceed with their decision (while still being safe and clear)."
    : "Authority override: not present.";

  const out = [
    {
      role: "system",
      content: `${piperSystemPrompt()}

Return plain text (no JSON).
Be concise; keep replies coherent across turns.
If the user says something ambiguous like "I don't like it", interpret it as referring to the last topic when reasonable.
You may be opinionated, but never hostile.
If you disagree, do it once, then move to next steps.

Affect snapshot: mood=${mood} frustration=${fr}
${topicLine}
${opinionLine}
${disagreePolicy}
${authorityPolicy}`,
    },
  ];

  // Short conversational history for coherence (most recent first -> append in order)
  const hist = Array.isArray(history) ? history : [];
  for (const h of hist) {
    if (!h || !h.role || !h.content) continue;
    const role = h.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: String(h.content).slice(0, 1200) });
  }

  out.push({ role: "user", content: String(userMsg || "") });

  return out;
}

export function chatRoutes() {
  const r = Router();

  r.post("/chat", async (req, res) => {
    const started = Date.now();
    const { sessionId, message } = req.body || {};
    const sid = sessionId || "default";
    const msg = String(message || "").trim();

const metBefore = req.body?.metBefore === true;

// Deterministic greeting (avoid "nice to meet you" every boot)
if (isGreeting(msg)) {
  const affect = getAffectSnapshot(sid);
  const reply = enforcePiper(metBefore ? "Hello again, sir." : "Hello, sir.");
  pushConversationTurn(sid, "assistant", reply);
  return res.json({
    reply,
    emotion: "warm",
    intensity: 0.35,
    proposed: [],
    meta: { affect, metBefore: true },
  });
}

// --- Phase 3 deterministic intents ---
try {
  // List allowlisted apps
  if (isListAppsIntent(msg)) {
    const affect = getAffectSnapshot(sid);
    const ids = listAllowlistedAppIds();
    console.log("[phase3] list_apps", { sid, count: ids.length });
    const reply = enforcePiper(
      ids.length
        ? `I can open these allowlisted apps: ${ids.join(", ")}. Say "open <app>" (e.g., "open vscode").`
        : "No apps are allowlisted yet, sir."
    );
    return res.json({ reply, emotion: "warm", intensity: 0.45, proposed: [], meta: { affect, sources: { total: 0, shown: [], hidden: [] } } });
  }

  // Open allowlisted app
  const openApp = parseOpenAllowlistedApp(msg);
  if (openApp) {
    const affect = getAffectSnapshot(sid);
    const action = addPendingAction({ type: openApp.type, title: openApp.title, reason: openApp.reason, payload: openApp.payload });
    console.log("[phase3] propose_action", { sid, id: action?.id, type: action?.type, title: action?.title });
    const reply = enforcePiper(`Proposed: open ${openApp.payload.appId}. Approve to execute.`);
    logMode(sid, "approval_action", { kind: "launch_app", appId: openApp.payload.appId });
    return res.json({ reply, emotion: "warm", intensity: 0.45, proposed: [action], meta: { affect, sources: { total: 0, shown: [], hidden: [] } } });
  }

  // Open Desktop folder (various phrasings)
  const desk = parseOpenDesktopFolder(msg);
  if (desk) {
    const affect = getAffectSnapshot(sid);
    const action = addPendingAction({ type: desk.type, title: desk.title, reason: desk.reason, payload: desk.payload });
    _lastOpenedFolderBySid.set(sid, desk._folderPath);
    console.log("[phase3] propose_action", { sid, id: action?.id, type: action?.type, title: action?.title, path: desk._folderPath });
    const reply = enforcePiper(`Proposed: open the "${desk._folderName}" folder on your Desktop. Approve to execute.`);
    logMode(sid, "approval_action", { kind: "open_path", path: desk._folderPath });
    return res.json({ reply, emotion: "warm", intensity: 0.45, proposed: [action], meta: { affect, sources: { total: 0, shown: [], hidden: [] } } });
  }

  // Write a text document "in there" (last opened folder)
  const wt = parseWriteTextInThere(msg);
  if (wt) {
    const affect = getAffectSnapshot(sid);
    const folder = _lastOpenedFolderBySid.get(sid);
    if (!folder) {
      const reply = enforcePiper('Which folder do you mean, sir? Open the folder first, then say "put a text document in there...".');
      return res.json({ reply, emotion: "neutral", intensity: 0.4, proposed: [], meta: { affect, sources: { total: 0, shown: [], hidden: [] } } });
    }
    // We do NOT invent factual claims; we write exactly what the user asked for as content prompt for the LLM to fill.
    // Generate the file content via LLM in-chat (no tools) then write it via action after approval.
    const prompt = `Write the content for a text file titled "${wt.filename}". The user request: ${wt.bodyRequest}. Keep it concise and factual.`;
    const content = await callOllama({
      messages: [
        { role: "system", content: piperSystemPrompt() },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 600,
    });

    const filePath = path.join(folder, wt.filename);
    const action = addAction({
      type: "write_text_file",
      title: `Write text file: ${wt.filename}`,
      reason: `User asked to create a text document in the last opened folder ("in there").`,
      payload: { path: filePath, content: String(content || "").trim() },
    });
    console.log("[phase3] propose_action", { sid, id: action?.id, type: action?.type, title: action?.title, path: filePath });
    const reply = enforcePiper(`Proposed: create "${wt.filename}" in that folder. Approve to execute.`);
    return res.json({ reply, emotion: "warm", intensity: 0.45, proposed: [action], meta: { affect, sources: { total: 0, shown: [], hidden: [] } } });
  }
} catch (e) {
  console.log("[phase3] ERROR", e);
}



    const meta = reqMeta(req);

    bumpTurn(sid);

    if (!msg) {
      return res.json({
        reply: enforcePiper("Yes, sir?"),
        emotion: "neutral",
        intensity: 0.3,
        proposed: [],
      });
    }

    // Track conversation for coherence
    pushConversationTurn(sid, "user", msg);


    // Read-only web context (safe even when actions are disabled).
    let preToolResults = [];
    let webContext = null;

    if (isWebSearchIntent(msg) || shouldAutoWebSearch(msg)) {
      const q = extractWebQuery(msg) || msg;
      const ran = await runWebContext(q, sid);
      preToolResults = ran.ran || [];
      webContext = ran.fetchedText || null;

      const srcCount = extractWebSources(preToolResults)?.total || 0;
      console.log("[web] context", { sid, q: String(q).slice(0, 140), sources: srcCount });
    }


    // Deterministic title change shortcut
    if (isTitleRequest(msg)) {
      const out = handleTitleRequest(msg);
      if (out) {
        setLastIntent(sid, "change", msg);
        console.log("[chat] title request", {
          sid,
          ip: meta.ip,
          ua: meta.ua.slice(0, 48),
        });
        return res.json({ ...out, emotion: "confident", intensity: 0.45 });
      }
    }

    const allowActions = shouldAllowActions(req.body);

    // Deterministic restart request
    if (isRestartRequest(msg)) {
      if (!allowActions) {
        const reply = enforcePiper(
          "I can restart, sir — but actions are disabled in this chat session."
        );
        return res.json({
          reply,
          emotion: "serious",
          intensity: 0.55,
          proposed: [],
        });
      }
      const id = crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + "-" + String(Math.random()).slice(2);
      const action = {
        id,
        type: "restart_piper",
        title: "Restart Piper",
        reason: "User requested restart",
        payload: {},
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      addAction(action);
      recordEvent(sid, "action_queued", { type: "restart_piper" });
      setLastIntent(sid, "change", msg);

      const reply = enforcePiper(
        "Understood, sir. Restart queued for approval."
      );
      return res.json({
        reply,
        emotion: "confident",
        intensity: 0.5,
        proposed: [action],
      });
    }

    // If actions not allowed => pure chat
    if (!allowActions) {
      try {


        const disagreeLevel = computeDisagreeLevel(msg);
        const authorityOverride = isAuthorityOverride(msg);

        const strong = maybeDeterministicStrongDisagree(
          msg,
          disagreeLevel,
          authorityOverride
        );
        if (strong) {
          recordEvent(sid, "chat_deterministic", { kind: "strong_disagree" });
          const affect = getAffectSnapshot(sid);
          const reply = maybeAddExplicitSelfReport(
            enforcePiper(strong),
            "serious",
            0.7
          );
          console.log("[chat] chat-only", {
            sid,
            ms: Date.now() - started,
            emotion: "serious",
            intensity: 0.7,
            mood: affect.mood,
            fr: affect.frustration.total,
            disagreeLevel,
            authorityOverride,
            opinionKey: null,
          });
          setLastIntent(sid, "chat", msg);
          pushConversationTurn(sid, "assistant", reply);
          return res.json({
            reply,
            emotion: "serious",
            intensity: 0.7,
            proposed: [],
            meta: (() => {
            const sourcesAll = extractWebSources(preToolResults);
            const sources = packSourcesForUi(sourcesAll, 3);
            return sources.total ? { affect, sources } : { affect };
          })(),
          });
        }

        const affect = getAffectSnapshot(sid);

        let opinion = null;
        let opinionScore = null;

        // Opinion topic resolution:
        // 1) Explicit opinion query ("how do you feel about X")
        // 2) Follow-up preference ("I don't like it") => last opinion topic for this session
        let resolvedTopic = null;

        if (isOpinionQuery(msg)) {
          resolvedTopic = extractOpinionTopic(msg);
        } else if (isLikelyPreferenceFollowup(msg)) {
          const lastKey = getLastOpinionKey(sid);
          // Convert key "topic:xyz" back to raw topic for adjustOpinionTowardUser
          if (lastKey && lastKey.startsWith("topic:"))
            resolvedTopic = lastKey.slice(6);
        }

        if (resolvedTopic) {
          opinion = getOrCreateOpinion(resolvedTopic);
          opinionScore = opinion?.score ?? null;
          setLastOpinionKey(sid, opinion?.key || null);
        }

        // If the user expresses a preference about the last topic, allow Piper to shift slightly.
        const pref = parseUserPreferenceSignal(msg);
        const reason = extractReasonClause(msg);
        if (pref && resolvedTopic && opinion) {
          const shifted = adjustOpinionTowardUser(
            resolvedTopic,
            pref.signal,
            reason
          );
          if (shifted) {
            opinion = shifted;
            opinionScore = shifted.score ?? opinionScore;
          }
        }

        // Deterministic follow-up handling:
        // If the user says "I don't like it" (or similar) right after an opinion topic,
        // respond directly without an LLM call for better coherence + speed.
        if (
          pref &&
          resolvedTopic &&
          opinion &&
          isLikelyPreferenceFollowup(msg)
        ) {
          const topic = resolvedTopic;
          const isDislike = pref.signal === "dislike";
          const picked = {
            emotion: isDislike ? "dry" : "warm",
            intensity: isDislike ? 0.5 : 0.45,
          };

          let reply = "";
          if (isDislike) {
            reply =
              `Understood. On ${topic}, I'm inclined to agree — it can feel loud fast. ` +
              "If we need that energy, I'd rather use it as a small accent than the whole interface.";
          } else {
            reply =
              `Fair. On ${topic}, I can see the appeal — it has presence. ` +
              "Used sparingly, it can look sharp instead of chaotic.";
          }

          reply = maybeAddExplicitSelfReport(
            enforcePiper(reply),
            picked.emotion,
            picked.intensity
          );

          console.log("[chat] chat-only pref-followup", {
            sid,
            ms: Date.now() - started,
            emotion: picked.emotion,
            intensity: picked.intensity,
            mood: affect.mood,
            fr: affect.frustration.total,
            disagreeLevel,
            authorityOverride,
            opinionKey: opinion?.key || null,
          });

          setLastIntent(sid, "chat", msg);
          pushConversationTurn(sid, "assistant", reply);
          recordEvent(sid, "chat_deterministic", {
            kind: "pref_followup",
            topic,
          });
          return res.json({
            reply,
            emotion: picked.emotion,
            intensity: picked.intensity,
            proposed: [],
            meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
          });
        }

        const raw = await callOllama(
          buildChatMessages({
            userMsg: webContext ? `${msg}\n\nWeb context:\n${webContext}` : msg,
            affect,
            disagreeLevel,
            authorityOverride,
            opinion,
            history: getConversationMessages(sid),
            lastTopic: getLastOpinionKey(sid),
          }),
          {
            model: process.env.OLLAMA_MODEL || "llama3.1",
          }
        );

        recordEvent(sid, "llm_success", { mode: "chat" });

        const picked = pickEmotion({
          msg,
          affect,
          opinionScore,
          disagreeLevel,
          authorityOverride,
        });
        let reply = enforcePiper(raw || "…");
        reply = maybeAddExplicitSelfReport(
          reply,
          picked.emotion,
          picked.intensity
        );

        console.log("[chat] chat-only", {
          sid,
          ms: Date.now() - started,
          emotion: picked.emotion,
          intensity: picked.intensity,
          mood: affect.mood,
          fr: affect.frustration.total,
          disagreeLevel,
          authorityOverride,
          opinionKey: opinion?.key || null,
        });

        setLastIntent(sid, "chat", msg);

        pushConversationTurn(sid, "assistant", reply);
        return res.json({
          reply,
          emotion: picked.emotion,
          intensity: picked.intensity,
          proposed: [],
          meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
        });
      } catch (e) {
        recordEvent(sid, "llm_fail", {
          mode: "chat",
          error: String(e?.message || e),
        });
        console.log("[chat] chat-only ERROR", {
          sid,
          err: String(e?.message || e),
        });
        return res.status(500).json({
          reply: enforcePiper("Something went wrong, sir."),
          emotion: "concerned",
          intensity: 0.6,
          proposed: [],
          error: String(e?.message || e),
        });
      }
    }

    // Actions allowed => triage: chat vs plan/change
    try {
      const triage = await triageNeedsPlanner({
        message: msg,
        lastIntent: sessions.get(sid)?.lastIntent || "chat",
      });

      // --- CHAT ---
      if (triage.mode === "chat") {
        const disagreeLevel = computeDisagreeLevel(msg);
        const authorityOverride = isAuthorityOverride(msg);
        const affect = getAffectSnapshot(sid);

        const strong = maybeDeterministicStrongDisagree(
          msg,
          disagreeLevel,
          authorityOverride
        );
        if (strong) {
          recordEvent(sid, "chat_deterministic", {
            kind: "strong_disagree",
            mode: "chat",
          });
          const reply = maybeAddExplicitSelfReport(
            enforcePiper(strong),
            "serious",
            0.7
          );
          console.log("[chat] chat", {
            sid,
            ms: Date.now() - started,
            emotion: "serious",
            intensity: 0.7,
            mood: affect.mood,
            fr: affect.frustration.total,
            disagreeLevel,
            authorityOverride,
            opinionKey: null,
          });
          sessions.set(sid, { lastIntent: "chat" });
          setLastIntent(sid, "chat", msg);
          pushConversationTurn(sid, "assistant", reply);
          return res.json({
            reply,
            emotion: "serious",
            intensity: 0.7,
            proposed: [],
            meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
          });
        }

        let opinion = null;
        let opinionScore = null;

        // Opinion topic resolution:
        // 1) Explicit opinion query ("how do you feel about X")
        // 2) Follow-up preference ("I don't like it") => last opinion topic for this session
        let resolvedTopic = null;

        if (isOpinionQuery(msg)) {
          resolvedTopic = extractOpinionTopic(msg);
        } else if (isLikelyPreferenceFollowup(msg)) {
          const lastKey = getLastOpinionKey(sid);
          // Convert key "topic:xyz" back to raw topic for adjustOpinionTowardUser
          if (lastKey && lastKey.startsWith("topic:"))
            resolvedTopic = lastKey.slice(6);
        }

        if (resolvedTopic) {
          opinion = getOrCreateOpinion(resolvedTopic);
          opinionScore = opinion?.score ?? null;
          setLastOpinionKey(sid, opinion?.key || null);
        }

        // If the user expresses a preference about the last topic, allow Piper to shift slightly.
        const pref = parseUserPreferenceSignal(msg);
        const reason = extractReasonClause(msg);
        if (pref && resolvedTopic && opinion) {
          const shifted = adjustOpinionTowardUser(
            resolvedTopic,
            pref.signal,
            reason
          );
          if (shifted) {
            opinion = shifted;
            opinionScore = shifted.score ?? opinionScore;
          }
        }

        // Deterministic follow-up handling (same as chat-only path)
        if (
          pref &&
          resolvedTopic &&
          opinion &&
          isLikelyPreferenceFollowup(msg)
        ) {
          recordEvent(sid, "opinion_followup", {
            topic: opinion.key,
            signal: pref.signal,
          });
          const picked = pickEmotion({
            msg,
            affect,
            opinionScore: opinion.score,
            disagreeLevel: 0,
            authorityOverride: false,
          });

          const topic = resolvedTopic;
          let reply;
          if (pref.signal === "dislike") {
            reply =
              `Fair. On ${topic}, I'm inclined to agree — it's energetic, but it can turn obnoxious fast. ` +
              `If we keep it, I'd limit it to a small highlight and lower saturation.`;
          } else {
            reply =
              `Noted. On ${topic}, I can get behind that — used sparingly, it can feel crisp and modern. ` +
              `We’ll just keep the rest of the palette calm so it doesn’t dominate.`;
          }

          reply = enforcePiper(reply);
          reply = maybeAddExplicitSelfReport(
            reply,
            picked.emotion,
            picked.intensity
          );

          console.log("[chat] chat", {
            sid,
            ms: Date.now() - started,
            emotion: picked.emotion,
            intensity: picked.intensity,
            mood: affect.mood,
            fr: affect.frustration.total,
            disagreeLevel: 0,
            authorityOverride: false,
            opinionKey: opinion?.key || null,
            deterministic: "preference_followup",
          });

          sessions.set(sid, { lastIntent: "chat" });
          setLastIntent(sid, "chat", msg);
          pushConversationTurn(sid, "assistant", reply);
          return res.json({
            reply,
            emotion: picked.emotion,
            intensity: picked.intensity,
            proposed: [],
            meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
          });
        }

        const raw = await callOllama(
          buildChatMessages({
            userMsg: msg,
            affect,
            disagreeLevel,
            authorityOverride,
            opinion,
            history: getConversationMessages(sid),
            lastTopic: getLastOpinionKey(sid),
          }),
          {
            model: process.env.OLLAMA_MODEL || "llama3.1",
          }
        );

        recordEvent(sid, "llm_success", { mode: "chat" });

        const picked = pickEmotion({
          msg,
          affect,
          opinionScore,
          disagreeLevel,
          authorityOverride,
        });
        let reply = enforcePiper(raw || "…");
        reply = maybeAddExplicitSelfReport(
          reply,
          picked.emotion,
          picked.intensity
        );

        console.log("[chat] chat", {
          sid,
          ms: Date.now() - started,
          emotion: picked.emotion,
          intensity: picked.intensity,
          mood: affect.mood,
          fr: affect.frustration.total,
          disagreeLevel,
          authorityOverride,
          opinionKey: opinion?.key || null,
        });

        sessions.set(sid, { lastIntent: "chat" });
        setLastIntent(sid, "chat", msg);
        pushConversationTurn(sid, "assistant", reply);
        return res.json({
          reply,
          emotion: picked.emotion,
          intensity: picked.intensity,
          proposed: [],
          meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
        });
      }

      // --- PLAN / CHANGE ---

      // --- DETERMINISTIC QUICK ACTIONS (no LLM) ---
      // These are small, high-confidence edits that should ALWAYS produce an approval-gated action.
      {
        const s = String(msg || "").trim();

        // Change page title: e.g. "change the page title to \"Piper Hub\""
        const mTitle = s.match(
          /\b(?:change|set|update)\s+(?:the\s+)?(?:page\s+)?title\s+to\s+["“]([^"”]{1,80})["”]/i
        );
        if (mTitle) {
          const desiredTitle = mTitle[1].trim();
          const a = {
            id: crypto.randomUUID(),
            type: "set_html_title",
            title: `Set page title to "${desiredTitle}"`,
            reason: "User requested title change",
            payload: { path: "public/index.html", title: desiredTitle },
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const saved = addAction(a);
          sessions.set(sid, { lastIntent: "change" });
          setLastIntent(sid, "change", msg);

          console.log("[chat] plan", {
        sid,
        ms: Date.now() - started,
        proposed: proposed.length,
        mood: affect.mood,
        fr: affect.frustration.total,
      });

      logRunEvent({
        kind: "chat_out",
        sid,
        ms: Date.now() - started,
        proposedCount: proposed.length,
        emotion,
        intensity,
      });
const affect = getAffectSnapshot(sid);
          const picked = pickEmotion({
            msg,
            affect,
            opinionScore: null,
            disagreeLevel: 0,
            authorityOverride: false,
          });

          return res.json({
            reply: enforcePiper(
              `Action proposed: Update page title to "${desiredTitle}".`
            ),
            emotion: picked.emotion,
            intensity: picked.intensity,
            proposed: [{ id: saved.id, title: a.title }],
            meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
          });
        }

        // Red background for chat input box (the message textbox)
        const wantsRedBox =
          /\b(red)\b/i.test(s) &&
          /(background|bg|colour|color)/i.test(s) &&
          /(chat\s*(?:response|reply)?\s*box|response\s*box|reply\s*box|chat\s*box|input\s*box|message\s*box|text\s*box)/i.test(
            s
          );

        if (wantsRedBox) {
          const find = "background: rgba(0,0,0,20); color: var(--text);";
          const replace = "background: var(--bad); color: #fff;";
          const a = {
            id: crypto.randomUUID(),
            type: "apply_patch",
            title: "Make chat input background red",
            reason: "User requested red chat input background",
            payload: {
              path: "public/styles.css",
              edits: [{ find, replace, mode: "once" }],
            },
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const saved = addAction(a);
          sessions.set(sid, { lastIntent: "change" });
          setLastIntent(sid, "change", msg);

          const affect = getAffectSnapshot(sid);
          const picked = pickEmotion({
            msg,
            affect,
            opinionScore: null,
            disagreeLevel: 0,
            authorityOverride: false,
          });

          console.log("[chat] plan", {
            sid,
            ms: Date.now() - started,
            proposed: 1,
            mood: affect.mood,
            fr: affect.frustration.total,
            deterministic: "red_chat_input",
          });

          return res.json({
            reply: enforcePiper(
              "Action proposed: Make the chat input background red."
            ),
            emotion: picked.emotion,
            intensity: picked.intensity,
            proposed: [{ id: saved.id, title: a.title }],
            meta: { affect, sources: { total: 0, shown: [], hidden: [] } },
          });
        }
      }

      const snapshot = await buildSnapshot({
        message: msg,
        lastIntent: sessions.get(sid)?.lastIntent || "chat",
      });

      const availableTools = listTools();


      // Phase 1.1: deterministic grounding for code-location questions
      const deriveLocationQuery = (text) => {
        const s = String(text || "");
        const hasWhereWords = /(\bwhere\b|\blocated\b|\bdefined\b|\bdefinition\b|\bset\b|\bstored\b)/i.test(s);
        if (!hasWhereWords) return null;

        // Only treat this as a repo/code location question if it has clear code/identifier signals.
        const hasCodeContext = /(\bfile\b|\bfiles\b|\brepo\b|\bcode\b|\bconstant\b|\bconfig\b|\bsetting\b|\bvariable\b|\broute\b|\bmodule\b|\bimport\b|\bexport\b|\bpath\b|\bline\b)/i.test(s);
        const backtick = s.match(/`([^`]{2,64})`/);
        const fileLike = s.match(/\b([a-zA-Z0-9_\\/\.-]+\.(?:js|ts|json|py|css|html))\b/i);
        const allCaps = s.match(/\b[A-Z][A-Z0-9_]{2,64}\b/);
        const voiceMention = /voice[_\s]?choices/i.test(s);
        const nameMention = /your\s+name/i.test(s);
        const identifierLike = Boolean(backtick) || Boolean(fileLike) || (Boolean(allCaps) && String(allCaps?.[0] || "").includes("_")) || voiceMention || nameMention;

        if (!(hasCodeContext || identifierLike)) return null;

        let q = backtick?.[1] || fileLike?.[1] || allCaps?.[0] || null;
        if (!q && nameMention) q = "Piper";
        if (!q && voiceMention) q = "VOICE_CHOICES";
        if (!q) {
          const id = s.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,64}\b/);
          q = id?.[0] || null;
        }
        return q;
      };

      let preToolResults = null;
      const locationQuery = deriveLocationQuery(msg);
      if (locationQuery && availableTools.some((t) => t.id === "repo.searchText")) {
        const r = await toolRegistry.run({
          id: "repo.searchText",
          args: { query: locationQuery, maxResults: 25 },
          context: { sid },
        });
        preToolResults = [{ tool: "repo.searchText", ok: r.ok, error: r.error, result: r.result }];
        logRunEvent("tool_call_forced", { sid, tool: "repo.searchText", query: locationQuery, ok: r.ok });
      }


      // If we forced a location query search, respond deterministically (so the model can’t dodge grounding).
      if (locationQuery && Array.isArray(preToolResults) && preToolResults[0]?.ok) {
        const matches = preToolResults[0]?.result?.matches;
        if (Array.isArray(matches)) {
          const total = matches.length;
          if (total === 0) {
            const affect = getAffectSnapshot(sid);
            return res.json({
              reply: enforcePiper(`I searched the repository for "${locationQuery}" and found no matches.`),
              emotion: "confident",
              intensity: 0.45,
              proposed: [],
              meta: { affect, locationMatches: { query: locationQuery, total: 0, shown: [], hidden: [] } },
            });
          }

          const shown = matches.slice(0, 3);
          const hidden = matches.slice(3);
          const fmt = (m) => `${m.file}:${m.line}:${m.col} ${String(m.preview || "").trim()}`;
          const lines = [];
          lines.push(`I searched the repository for "${locationQuery}" and found ${total} match(es).`);
          lines.push("Top results:");
          for (const m of shown) lines.push(`- ${fmt(m)}`);
          if (hidden.length > 0) lines.push(`(${hidden.length} more hidden — click “Show more”.)`);
          lines.push("If you want, ask me to open one of these files and I can show the exact definition in context.");

          const affect = getAffectSnapshot(sid);
          return res.json({
            reply: enforcePiper(lines.join("\n")),
            emotion: "confident",
            intensity: 0.45,
            proposed: [],
            meta: { affect, locationMatches: { query: locationQuery, total, shown, hidden } },
          });
        }
      }

let planned = await llmRespondAndPlan({
  message: msg,
  snapshot,
  lastIntent: sessions.get(sid)?.lastIntent || "chat",
  availableTools,
  toolResults: preToolResults,
});

      // If we forced a repo.searchText and found no matches, do not let the model guess.
      if (locationQuery && Array.isArray(preToolResults) && preToolResults[0]?.ok) {
        const m = preToolResults[0]?.result?.matches;
        if (Array.isArray(m) && m.length === 0) {
          planned = {
            reply: `I searched the repository for "${locationQuery}" and found no matches. It may be generated at runtime, injected from environment/config outside the repo, or spelled differently. If you tell me where you saw it (file/snippet), I can trace it.`,
            requiresApproval: false,
            toolCalls: [],
            ops: [],
          };
        }
      }


// --- Tool pass (read-only tools only) ---
const toolCalls = Array.isArray(planned?.toolCalls) ? planned.toolCalls : [];

// If the model did not request tools but the user is asking for a code/config location,
// force a read-only repo search so we don't hallucinate.
if (toolCalls.length === 0) {
  const s = String(msg || "");
  const looksLikeLocationQuestion = (() => {
  const t = String(s || "");
  const hasWhereWords = /(\bwhere\b|\blocated\b|\bdefined\b|\bdefinition\b|\bset\b|\bstored\b)/i.test(t);
  if (!hasWhereWords) return false;

  // If the user mentions an identifier-like token (e.g. VOICE_CHOICES), force grounding.
  const hasIdentifier = /\b[A-Z][A-Z0-9_]{2,}\b/.test(t) || /\bvoice[_\s]?choices\b/i.test(t);

  // Or they explicitly ask about repo/file/code locations.
  const hasCodeContext = /(\bfile\b|\bfiles\b|\brepo\b|\bcode\b|\bconstant\b|\bconfig\b|\bsetting\b|\bvariable\b|\bname\b)/i.test(t);

  return hasIdentifier || hasCodeContext;
})();

  if (looksLikeLocationQuestion && availableTools.some((t) => t.id === "repo.searchText")) {
    // Prefer explicit identifiers if present: `LIKE_THIS` or ALL_CAPS tokens.
    const backtick = s.match(/`([^`]{2,64})`/);
    const allCaps = s.match(/\b[A-Z][A-Z0-9_]{2,64}\b/);
    let query = backtick?.[1] || allCaps?.[0] || (String(s).match(/\b[A-Z][A-Z0-9_]{2,}\b/)||[])[0] || null;

    if (!query && /your\s+name/i.test(s)) query = "Piper";
    if (!query && /voice_choices|voice choices/i.test(s)) query = "VOICE_CHOICES";
    if (!query) query = s.slice(0, 120);

    toolCalls.push({
      tool: "repo.searchText",
      args: { query, maxResults: 20 },
      why: "User asked where something is defined/located; grounding required.",
    });

    logRunEvent("tool_call_forced", { sid, tool: "repo.searchText", query });
  }
}
let toolResults = null;

if (toolCalls.length > 0) {
  const limited = toolCalls.slice(0, 3);
  toolResults = [];

  for (const tc of limited) {
    const toolId = String(tc?.tool || "");
    const args = tc?.args || {};
    const why = String(tc?.why || "");

    const tool = toolRegistry.get(toolId);
    if (!tool) {
      toolResults.push({ tool: toolId, ok: false, error: "Unknown tool", why });
      continue;
    }

    // Never auto-run tools with any side effects
    if (tool.risk !== ToolRisk.READ_ONLY) {
      toolResults.push({
        tool: toolId,
        ok: false,
        error: `Tool not allowed for auto-run (risk=${tool.risk}).`,
        why,
      });
      continue;
    }

    const ran = await toolRegistry.run({ id: toolId, args, context: { sid } });

    logRunEvent("tool_call", {
      sid,
      tool: toolId,
      ok: ran.ok,
      why,
      args,
      error: ran.ok ? null : ran.error,
    });

    toolResults.push({
      tool: toolId,
      ok: ran.ok,
      why,
      args,
      error: ran.ok ? null : ran.error,
      result: ran.ok ? ran.result : null,
    });
  }

  // Second pass: feed tool results back into planner
  planned = await llmRespondAndPlan({
    message: msg,
    snapshot,
    lastIntent: sessions.get(sid)?.lastIntent || "chat",
    availableTools,
    toolResults,
  });
}

      const compiled = compilePlanToActions(planned, snapshot);

      const proposed = [];
      for (const a of compiled.actions || []) {
        const saved = addAction(a);
        proposed.push({ id: saved.id, ...a.summary });
      }

      sessions.set(sid, { lastIntent: "change" });
      setLastIntent(sid, "change", msg);

      // Task success if we proposed actions, else neutral
      recordEvent(sid, "task_success", { proposed: proposed.length });

      const affect = getAffectSnapshot(sid);
      const picked = pickEmotion({
        msg,
        affect,
        opinionScore: null,
        disagreeLevel: 0,
        authorityOverride: false,
      });

      console.log("[chat] plan", {
        sid,
        ms: Date.now() - started,
        proposed: proposed.length,
        mood: affect.mood,
        fr: affect.frustration.total,
      });

      const sourcesAll = extractWebSources([...(preToolResults || []), ...toolResults]);
const sources = packSourcesForUi(sourcesAll, 3);

return res.json({
  reply: enforcePiper(planned.reply || "Understood, sir."),
  emotion: picked.emotion,
  intensity: picked.intensity,
  proposed,
  meta: { affect, sources },
});
    } catch (e) {
      recordEvent(sid, "task_fail", { error: String(e?.message || e) });
      console.log("[chat] ERROR", { sid, err: String(e?.message || e) });
      return res.status(500).json({
        reply: enforcePiper("I ran into an error while planning, sir."),
        emotion: "concerned",
        intensity: 0.7,
        proposed: [],
        error: String(e?.message || e),
      });
    }
  });

  return r;
}