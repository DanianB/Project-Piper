// src/services/mind.js
//
// Piper "Mind" Layer (Global persistence + lightweight per-session state)
//
// Goals:
// - Stable opinions/preferences that persist across restarts.
// - Mood baseline that drifts slowly and decays toward neutral.
// - Track frustration from repeated failures (LLM/TTS/actions) to shape tone.
// - Fast: small JSON read/write, no extra LLM calls.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as PATHS from "../config/paths.js";

const ROOT = PATHS.ROOT || process.cwd();
const DATA_DIR = PATHS.DATA_DIR || path.join(ROOT, "data");
const MIND_PATH = path.join(DATA_DIR, "piper_mind.json");

function nowMs() {
  return Date.now();
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function djb2u32(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0);
}

function stableRand01(key) {
  // Deterministic [0,1)
  const u = djb2u32(key);
  return (u % 1000000) / 1000000;
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

const DEFAULT_MIND = {
  version: 1,
  createdAt: nowMs(),
  updatedAt: nowMs(),

  // Global persistent opinions keyed by a normalized topic key.
  // value: { score: -1..+1, stance: string, rationale: string, createdAt, updatedAt }
  opinions: {},

  // Optional preferences
  prefs: {},

  // Global mood baseline (slow drift). -1..+1
  moodBaseline: 0.0,

  // Global frustration aggregates (decay). 0..3 each
  frustration: { llm: 0, tts: 0, task: 0 },

  // Throttle for explicit self-report
  lastExplicitAt: 0,
};

let _mind = null;

// In-memory per-session state (not fully persisted)
const _sessions = new Map();

function loadMind() {
  ensureDataDir();
  try {
    if (fs.existsSync(MIND_PATH)) {
      const raw = fs.readFileSync(MIND_PATH, "utf8");
      const j = JSON.parse(raw);
      _mind = { ...DEFAULT_MIND, ...(j || {}) };
      _mind.opinions = _mind.opinions || {};
      _mind.prefs = _mind.prefs || {};
      _mind.frustration = { ...DEFAULT_MIND.frustration, ...(_mind.frustration || {}) };
      return _mind;
    }
  } catch (e) {
    console.warn("[mind] Failed to load piper_mind.json:", e?.message || e);
  }
  _mind = { ...DEFAULT_MIND };
  saveMind();
  return _mind;
}

function saveMind() {
  ensureDataDir();
  try {
    _mind.updatedAt = nowMs();
    fs.writeFileSync(MIND_PATH, JSON.stringify(_mind, null, 2), "utf8");
  } catch (e) {
    console.warn("[mind] Failed to save piper_mind.json:", e?.message || e);
  }
}

export function getMind() {
  if (!_mind) loadMind();
  return _mind;
}

export function getSessionState(sessionId = "default") {
  const id = String(sessionId || "default");
  const existing = _sessions.get(id);
  if (existing) return existing;

  const s = {
    id,
    turns: 0,
    lastIntent: "chat",
    lastMsg: "",
    sessionMood: 0.0, // faster-reacting delta
    streaks: { llmFail: 0, ttsFail: 0, taskFail: 0 },
    lastDisagreeAt: 0,

    // Short conversational memory for coherence (in-RAM per session).
    // Stored as [{role:"user"|"assistant", content:string, at:number}]
    convo: [],
    // Track last opinion topic discussed so follow-ups like "I don't like it" resolve.
    lastOpinionKey: null,
  };

  _sessions.set(id, s);
  return s;
}


export function bumpTurn(sessionId) {
  const s = getSessionState(sessionId);
  s.turns += 1;
  return s.turns;
}

export function setLastIntent(sessionId, intent, msg) {
  const s = getSessionState(sessionId);
  s.lastIntent = String(intent || "chat");
  s.lastMsg = String(msg || "");
}

// ---------------- Conversation memory helpers ----------------

export function pushConversationTurn(sessionId, role, content) {
  const s = getSessionState(sessionId);
  const r = role === "assistant" ? "assistant" : "user";
  const c = String(content || "").trim();
  if (!c) return;

  s.convo.push({ role: r, content: c, at: nowMs() });

  // Keep last N turns to avoid prompt bloat
  const maxTurns = Number(process.env.PIPER_CONVO_TURNS || "12"); // user+assistant pairs
  const maxItems = Math.max(4, maxTurns * 2);
  if (s.convo.length > maxItems) s.convo.splice(0, s.convo.length - maxItems);
}

export function getConversationMessages(sessionId) {
  const s = getSessionState(sessionId);
  return Array.isArray(s.convo) ? s.convo.slice() : [];
}

export function setLastOpinionKey(sessionId, key) {
  const s = getSessionState(sessionId);
  s.lastOpinionKey = key ? String(key) : null;
}

export function getLastOpinionKey(sessionId) {
  const s = getSessionState(sessionId);
  return s.lastOpinionKey ? String(s.lastOpinionKey) : null;
}

/**
 * Adjust an existing opinion score slightly based on user's stated preference or argument.
 * This is intentionally conservative; it creates "change your mind" without mood swings.
 *
 * userSignal: "like" | "dislike"
 * Returns new opinion {key, score, stance, rationale} or null.
 */
export function adjustOpinionTowardUser(rawTopic, userSignal, reason = "") {
  const mind = getMind();
  const key = buildOpinionKey(rawTopic);
  if (!key) return null;

  const op = mind.opinions[key];
  if (!op || typeof op !== "object") return null;

  const signal = String(userSignal || "").toLowerCase();
  const hasReason = String(reason || "").trim().length > 0;

  // Small step; bigger if user provides a reason ("because ...")
  const stepBase = hasReason ? 0.18 : 0.10;
  const direction = signal === "like" ? +1 : signal === "dislike" ? -1 : 0;

  if (direction === 0) return { key, ...op };

  const oldScore = clamp(op.score ?? 0, -1, 1);
  // Move toward user's direction, but never jump fully
  let nextScore = oldScore + direction * stepBase;

  // If Piper already strongly disagrees, let a good reason nudge more.
  if (hasReason && Math.abs(oldScore - direction) > 1.2) nextScore += direction * 0.06;

  nextScore = clamp(nextScore, -1, 1);

  const stance =
    nextScore > 0.35 ? "like" :
    nextScore < -0.35 ? "dislike" :
    "mixed";

  const newRationale = hasReason
    ? `User argument considered: ${String(reason).slice(0, 180)}`
    : op.rationale || "";

  mind.opinions[key] = {
    ...op,
    score: nextScore,
    stance,
    rationale: newRationale,
    updatedAt: nowMs(),
  };

  saveMind();

  return { key, ...mind.opinions[key] };
}

function decayTowardZero(x, amt) {
  if (x > 0) return Math.max(0, x - amt);
  if (x < 0) return Math.min(0, x + amt);
  return 0;
}

export function recordEvent(sessionId, type, detail = {}) {
  // type: llm_success|llm_fail|tts_success|tts_fail|task_success|task_fail
  const mind = getMind();
  const s = getSessionState(sessionId);

  const t = String(type || "");
  const now = nowMs();

  // Light decay on every event
  mind.frustration.llm = Math.max(0, mind.frustration.llm - 0.05);
  mind.frustration.tts = Math.max(0, mind.frustration.tts - 0.05);
  mind.frustration.task = Math.max(0, mind.frustration.task - 0.05);
  s.sessionMood = decayTowardZero(s.sessionMood, 0.03);

  if (t === "llm_success") {
    s.streaks.llmFail = 0;
    mind.frustration.llm = Math.max(0, mind.frustration.llm - 0.3);
    mind.moodBaseline = clamp(mind.moodBaseline + 0.01, -1, 1);
    s.sessionMood = clamp(s.sessionMood + 0.02, -1, 1);
  } else if (t === "llm_fail") {
    s.streaks.llmFail += 1;
    mind.frustration.llm = clamp(mind.frustration.llm + 0.35, 0, 3);
    mind.moodBaseline = clamp(mind.moodBaseline - 0.02, -1, 1);
    s.sessionMood = clamp(s.sessionMood - 0.06, -1, 1);
  } else if (t === "tts_success") {
    s.streaks.ttsFail = 0;
    mind.frustration.tts = Math.max(0, mind.frustration.tts - 0.25);
    s.sessionMood = clamp(s.sessionMood + 0.01, -1, 1);
  } else if (t === "tts_fail") {
    s.streaks.ttsFail += 1;
    mind.frustration.tts = clamp(mind.frustration.tts + 0.35, 0, 3);
    s.sessionMood = clamp(s.sessionMood - 0.05, -1, 1);
  } else if (t === "task_success") {
    s.streaks.taskFail = 0;
    mind.frustration.task = Math.max(0, mind.frustration.task - 0.35);
    mind.moodBaseline = clamp(mind.moodBaseline + 0.015, -1, 1);
    s.sessionMood = clamp(s.sessionMood + 0.02, -1, 1);
  } else if (t === "task_fail") {
    s.streaks.taskFail += 1;
    mind.frustration.task = clamp(mind.frustration.task + 0.35, 0, 3);
    mind.moodBaseline = clamp(mind.moodBaseline - 0.02, -1, 1);
    s.sessionMood = clamp(s.sessionMood - 0.06, -1, 1);
  }

  // Global drift back to neutral slowly
  mind.moodBaseline = decayTowardZero(mind.moodBaseline, 0.004);

  saveMind();
  return { mind, session: s, detail, at: now };
}

// ---------------- Social signal → mood ----------------
// These are intentionally stronger than normal drift, and are NOT triggered by
// social rituals/utility queries (handled by the classifier).
export function recordSocialSignal(sessionId, kind, strength = 1.0) {
  const mind = getMind();
  const s = getSessionState(sessionId);
  const k = clamp(Number(strength) || 1.0, 0, 1);

  const t = String(kind || "").toUpperCase();
  if (t === "PRAISE") {
    s.sessionMood = clamp(s.sessionMood + 0.18 * k, -1, 1);
    mind.moodBaseline = clamp(mind.moodBaseline + 0.03 * k, -1, 1);
  } else if (t === "INSULT") {
    s.sessionMood = clamp(s.sessionMood - 0.22 * k, -1, 1);
    mind.moodBaseline = clamp(mind.moodBaseline - 0.04 * k, -1, 1);
  } else {
    return getAffectSnapshot(sessionId);
  }

  saveMind();
  return getAffectSnapshot(sessionId);
}

function normalizeTopic(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s:-]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function buildOpinionKey(rawTopic) {
  const t = normalizeTopic(rawTopic);
  if (!t) return null;
  return `topic:${t}`;
}

function pickFrom(arr, key) {
  const r = stableRand01(key);
  const idx = Math.floor(r * arr.length) % arr.length;
  return arr[idx];
}

function makeOpinionForTopic(topicKey) {
  // Stable sentiment from topicKey
  const r = stableRand01(topicKey);
  const score = clamp((r * 2 - 1) * 0.75, -1, 1); // mild by default
  const polarity = score > 0.18 ? "like" : score < -0.18 ? "dislike" : "mixed";

  const stances = {
    like: [
      "I rather like it.",
      "I’m fond of it.",
      "It’s a solid choice.",
      "It has a certain elegance.",
    ],
    mixed: [
      "I’m torn.",
      "It depends.",
      "I’m neutral on it—context matters.",
      "I can see both sides.",
    ],
    dislike: [
      "I’m not a fan.",
      "It doesn’t impress me.",
      "I’d avoid it if I can.",
      "I find it… inefficient.",
    ],
  };

  const rationales = {
    like: [
      "It’s bold without being chaotic.",
      "It tends to do what it says on the tin.",
      "It has presence—useful when clarity matters.",
      "It’s oddly reassuring in a noisy world.",
    ],
    mixed: [
      "It can be brilliant or obnoxious, depending on execution.",
      "It’s powerful, but easy to overdo.",
      "In moderation it’s excellent; in excess it’s exhausting.",
      "It shines in the right context and fights you in the wrong one.",
    ],
    dislike: [
      "It’s often more noise than signal.",
      "It attracts the wrong kind of complexity.",
      "It’s the kind of thing that looks clever until you maintain it.",
      "It’s usually a shortcut that charges interest later.",
    ],
  };

  return {
    score,
    stance: pickFrom(stances[polarity], topicKey + ":stance"),
    rationale: pickFrom(rationales[polarity], topicKey + ":why"),
  };
}

export function getOrCreateOpinion(rawTopic) {
  const mind = getMind();
  const key = buildOpinionKey(rawTopic);
  if (!key) return null;

  const existing = mind.opinions[key];
  if (existing && typeof existing === "object") {
    existing.updatedAt = nowMs();
    saveMind();
    return { key, ...existing };
  }

  const created = makeOpinionForTopic(key);
  mind.opinions[key] = {
    score: created.score,
    stance: created.stance,
    rationale: created.rationale,
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };

  pruneMind();
  saveMind();
  return { key, ...mind.opinions[key] };
}

export function getOpinionIfAny(rawTopic) {
  const mind = getMind();
  const key = buildOpinionKey(rawTopic);
  if (!key) return null;
  const existing = mind.opinions[key];
  if (!existing) return null;
  return { key, ...existing };
}

export function setOpinion(rawTopic, score, stance, rationale) {
  const mind = getMind();
  const key = buildOpinionKey(rawTopic);
  if (!key) return null;

  mind.opinions[key] = {
    score: clamp(score, -1, 1),
    stance: String(stance || "").slice(0, 220),
    rationale: String(rationale || "").slice(0, 280),
    createdAt: mind.opinions[key]?.createdAt || nowMs(),
    updatedAt: nowMs(),
  };

  pruneMind();
  saveMind();
  return { key, ...mind.opinions[key] };
}

export function shouldSelfReportExplicitly() {
  const mind = getMind();
  const last = Number(mind.lastExplicitAt || 0);
  return nowMs() - last > 25_000;
}

export function markSelfReportUsed() {
  const mind = getMind();
  mind.lastExplicitAt = nowMs();
  saveMind();
}

export function getAffectSnapshot(sessionId) {
  const mind = getMind();
  const s = getSessionState(sessionId);

  const total =
    (mind.frustration.llm || 0) + (mind.frustration.tts || 0) + (mind.frustration.task || 0);

  const mood = clamp((mind.moodBaseline || 0) + (s.sessionMood || 0), -1, 1);

  return {
    mood,
    moodBaseline: mind.moodBaseline || 0,
    sessionMood: s.sessionMood || 0,
    frustration: {
      llm: mind.frustration.llm || 0,
      tts: mind.frustration.tts || 0,
      task: mind.frustration.task || 0,
      total,
      streaks: { ...s.streaks },
    },
  };
}

export function pruneMind() {
  const mind = getMind();
  const opinions = mind.opinions || {};
  const keys = Object.keys(opinions);
  const limit = 250;
  if (keys.length <= limit) return;

  keys.sort((a, b) => (opinions[b]?.updatedAt || 0) - (opinions[a]?.updatedAt || 0));
  for (let i = limit; i < keys.length; i++) delete opinions[keys[i]];
  saveMind();
}
