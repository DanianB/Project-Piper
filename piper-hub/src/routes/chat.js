// src/routes/chat.js
import { Router } from "express";
import crypto from "crypto";
import { callOllama } from "../services/ollama.js";
import { enforcePiper, piperSystemPrompt } from "../services/persona.js";

import { triageNeedsPlanner } from "../planner/triage.js";
import { buildSnapshot } from "../planner/snapshot.js";
import { llmRespondAndPlan } from "../planner/planner.js";
import { compilePlanToActions } from "../planner/compiler.js";
import { addAction } from "../actions/store.js";

import {
  bumpTurn,
  getAffectSnapshot,
  getOrCreateOpinion,
  recordEvent,
  recordSocialSignal,
  pushConversationTurn,
  getConversationMessages,
  setLastOpinionKey,
  getLastOpinionKey,
  adjustOpinionTowardUser,
  setLastIntent,
  shouldSelfReportExplicitly,
  markSelfReportUsed,
} from "../services/mind.js";

import {
  classifyUserMessage,
  isOpinionQuery as isOpinionQuery2,
  extractOpinionTopic as extractOpinionTopic2,
  extractReasonClause as extractReasonClause2,
  isOpinionWorthyTopic,
  parseUserPreferenceSignal as parseUserPreferenceSignal2,
  parsePersuasionAttempt,
} from "../services/mind_classifier.js";

const sessions = new Map();

function newId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function shouldAllowActions(reqBody) {
  const userInitiated = reqBody?.userInitiated === true;
  const readOnly = Boolean(reqBody?.readOnly);
  return userInitiated && !readOnly;
}

function reqMeta(req) {
  const ua = String(req?.headers?.["user-agent"] || "");
  const ip = String(req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "");
  return { ua, ip };
}

// ---------------- Opinion detection ----------------

function isOpinionQuery(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("how do you feel about") ||
    m.includes("what do you think about") ||
    m.includes("your opinion on") ||
    m.startsWith("do you like ") ||
    m.startsWith("do you hate ") ||
    m.startsWith("do you love ")
  );
}

function deterministicOpinionReply(topic, opinion) {
  const t = String(topic || "").trim();
  const score = Number(opinion?.score ?? 0);
  const stance = String(opinion?.stance || "mixed");
  const rationale = String(opinion?.rationale || "").trim();

  const stanceLine =
    stance === "like" ? "warmly in favor" :
    stance === "dislike" ? "mildly against" :
    "mixed / neutral";

  let why = "";
  if (rationale) {
    why = ` Reasoning: ${rationale}`;
  } else {
    // fallback, keep it short
    if (score > 0.35) why = " It reads bold and decisive when used as an accent.";
    else if (score < -0.35) why = " It can get loud fast if it dominates the palette.";
    else why = " Context matters — accent vs. wall-to-wall.";
  }

  // Piper speaks as an assistant with an AI core: feelings + opinions are allowed.
  return `On ${t}, I feel ${stanceLine}.` + why;
}


function extractOpinionTopic(msg) {
  const s = String(msg || "").trim();
  // Patterns: "how do you feel about X", "what do you think about X", "your opinion on X"
  let m = s.match(/feel about\s+(.+)$/i);
  if (m && m[1]) return m[1].trim().replace(/[?.!]+$/, "");
  m = s.match(/think about\s+(.+)$/i);
  if (m && m[1]) return m[1].trim().replace(/[?.!]+$/, "");
  m = s.match(/opinion on\s+(.+)$/i);
  if (m && m[1]) return m[1].trim().replace(/[?.!]+$/, "");
  m = s.match(/do you (?:like|love|hate)\s+(.+)$/i);
  if (m && m[1]) return m[1].trim().replace(/[?.!]+$/, "");
  return null;
}


function parseUserPreferenceSignal(msg) {
  const s = String(msg || "").trim().toLowerCase();

  // strong negatives
  if (/(i\s+)?(really\s+)?(hate|can'?t\s+stand|despise)\b/.test(s)) return { signal: "dislike", strength: 0.8 };
  if (/(i\s+)?(don'?t|do not)\s+like\b/.test(s)) return { signal: "dislike", strength: 0.6 };
  if (/\bnot\s+a\s+fan\b/.test(s)) return { signal: "dislike", strength: 0.5 };

  // positives
  if (/(i\s+)?(really\s+)?(love|adore)\b/.test(s)) return { signal: "like", strength: 0.8 };
  if (/(i\s+)?(like|enjoy)\b/.test(s)) return { signal: "like", strength: 0.55 };

  return null;
}

function extractReasonClause(msg) {
  const s = String(msg || "").trim();
  // Keep it simple: capture after "because" if present
  const m = s.match(/because\s+([\s\S]{1,240})/i);
  return m && m[1] ? String(m[1]).trim() : "";
}

function isLikelyPreferenceFollowup(msg) {
  const s = String(msg || "").trim().toLowerCase();
  // short preference statements often omit the topic: "I don't like it"
  return /(don'?t\s+like|do not like|not a fan|hate|love|like it|don'?t like it)/.test(s);
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

function maybeDeterministicStrongDisagree(msg, disagreeLevel, authorityOverride) {
  if (authorityOverride) return null;
  if (disagreeLevel < 2) return null;

  const m = String(msg || "").toLowerCase();
  if (m.includes("rewrite everything") || m.includes("rewrite the whole") || m.includes("delete everything") || m.includes("wipe")) {
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

function pickEmotion({ msg, affect, opinionScore, disagreeLevel, authorityOverride }) {
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
    return { emotion: "angry", intensity: clamp01(0.65 + 0.12 * Math.min(1, fr / 3)) };
  }

  // If user is reporting problems
  if (m.includes("not working") || m.includes("error") || m.includes("slow") || m.includes("stuck")) {
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

  if (e === "angry") line = "I’m getting a bit impatient, sir — this should have behaved by now.";
  else if (e === "concerned") line = "I’m slightly concerned, sir — let’s keep it controlled and inspect first.";
  else if (e === "sad") line = "That’s… unfortunate. Let’s see what we can salvage.";
  else if (e === "excited") line = "I’m genuinely pleased with that result, sir.";
  else if (e === "confident") line = "I’m satisfied with this direction, sir.";

  if (!line) return text;

  markSelfReportUsed();
  return `${line}\n\n${text}`;
}

// ---------------- Deterministic title shortcut ----------------

function isRestartRequest(msg) {
  const s = String(msg || "").trim().toLowerCase();
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
  const m = String(msg || "").match(/(?:set|change)\s+(?:the\s+)?title\s+to\s+"([^"]+)"/i);
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

  return { reply: enforcePiper(`Queued for approval, sir. I will set the page title to "${desired}".`), proposed: [{ id, type: "set_html_title", title: `Set page title to "${desired}"` }] };
}

// ---------------- Chat route ----------------

function buildChatMessages({ userMsg, affect, disagreeLevel, authorityOverride, opinion, history, lastTopic }) {
  const mood = Number(affect?.mood || 0).toFixed(2);
  const fr = Number(affect?.frustration?.total || 0).toFixed(2);

  const opinionLine = opinion
    ? `Known opinion: ${opinion.key} score=${Number(opinion.score ?? 0).toFixed(2)} stance="${opinion.stance}" rationale="${String(opinion.rationale || "").slice(0, 220)}"`
    : "Known opinion: none";

  const topicLine = lastTopic ? `Last topic: ${String(lastTopic).slice(0, 140)}` : "Last topic: none";

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
    const meta = reqMeta(req);

    bumpTurn(sid);

    if (!msg) {
      return res.json({ reply: enforcePiper("Yes, sir?"), emotion: "neutral", intensity: 0.3, proposed: [] });
    }

    // Track conversation for coherence
    pushConversationTurn(sid, "user", msg);

    // Deterministic title change shortcut
    if (isTitleRequest(msg)) {
      const out = handleTitleRequest(msg);
      if (out) {
        setLastIntent(sid, "change", msg);
        console.log("[chat] title request", { sid, ip: meta.ip, ua: meta.ua.slice(0, 48) });
        return res.json({ ...out, emotion: "confident", intensity: 0.45 });
      }
    }

    const allowActions = shouldAllowActions(req.body);

    // Deterministic restart request
    if (isRestartRequest(msg)) {
      if (!allowActions) {
        const reply = enforcePiper("I can restart, sir — but actions are disabled in this chat session.");
        return res.json({ reply, emotion: "serious", intensity: 0.55, proposed: [] });
      }
      const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + String(Math.random()).slice(2);
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

      const reply = enforcePiper("Understood, sir. Restart queued for approval.");
      return res.json({ reply, emotion: "confident", intensity: 0.5, proposed: [action] });
    }


    // If actions not allowed => pure chat
    if (!allowActions) {
      try {
        const disagreeLevel = computeDisagreeLevel(msg);
        const authorityOverride = isAuthorityOverride(msg);

        const strong = maybeDeterministicStrongDisagree(msg, disagreeLevel, authorityOverride);
        if (strong) {
          recordEvent(sid, "chat_deterministic", { kind: "strong_disagree" });
          const affect = getAffectSnapshot(sid);
          const reply = maybeAddExplicitSelfReport(enforcePiper(strong), "serious", 0.7);
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
        return res.json({ reply, emotion: "serious", intensity: 0.7, proposed: [], meta: { affect } });
        }

        const affect = getAffectSnapshot(sid);

        let opinion = null;
        let opinionScore = null;

        // Opinion topic resolution:
        // 1) Explicit opinion query ("how do you feel about X")
        // 2) Follow-up preference ("I don't like it") => last opinion topic for this session
        let resolvedTopic = null;

        // Classify the user message for mood/opinion gating.
        const cls = classifyUserMessage(msg);
        if (cls?.kind === "SOCIAL_RITUAL" || cls?.kind === "UTILITY") {
          console.log("[mind] no-affect", { sid, kind: cls.kind, text: msg });
        } else if (cls?.kind === "PRAISE" || cls?.kind === "INSULT") {
          const nextAffect = recordSocialSignal(sid, cls.kind, 1.0);
          console.log("[mind]", cls.kind.toLowerCase(), { sid, mood: nextAffect.mood, text: msg });
        }

        if (isOpinionQuery2(msg)) {
          resolvedTopic = extractOpinionTopic2(msg);
        } else if (isLikelyPreferenceFollowup(msg)) {
          const lastKey = getLastOpinionKey(sid);
          // Convert key "topic:xyz" back to raw topic for adjustOpinionTowardUser
          if (lastKey && lastKey.startsWith("topic:")) resolvedTopic = lastKey.slice(6);
        }

        // Persuasion follow-up that refers to the last opinion topic without restating it
        // e.g. "Are you sure? it's your UI theme color."
        if (!resolvedTopic) {
          const persuasion = parsePersuasionAttempt(msg);
          if (persuasion?.signal) {
            const lastKey = getLastOpinionKey(sid);
            if (lastKey && lastKey.startsWith("topic:")) resolvedTopic = lastKey.slice(6);
          }
        }

        if (resolvedTopic) {
          opinion = getOrCreateOpinion(resolvedTopic);
          opinionScore = opinion?.score ?? null;
          setLastOpinionKey(sid, opinion?.key || null);
        }

        // Deterministic opinion query response (prevents "I can't have opinions" drift from the LLM)
        if (isOpinionQuery2(msg) && resolvedTopic && isOpinionWorthyTopic(resolvedTopic) && opinion) {
          const picked = pickEmotion({ msg, affect, opinionScore, disagreeLevel, authorityOverride });
          let reply = deterministicOpinionReply(resolvedTopic, opinion);

          // If the user is actively persuading in the same turn (rare), apply the nudge.
          const persuasion = parsePersuasionAttempt(msg);
          const reasonNow = extractReasonClause2(msg);
          if (persuasion?.signal) {
            const shifted = adjustOpinionTowardUser(resolvedTopic, persuasion.signal, reasonNow);
            if (shifted) {
              opinion = shifted;
              opinionScore = shifted.score;
              reply = deterministicOpinionReply(resolvedTopic, opinion);
              console.log("[mind] persuasion", { sid, topic: resolvedTopic, signal: persuasion.signal, reason: reasonNow });
            }
          }

          reply = maybeAddExplicitSelfReport(enforcePiper(reply), picked.emotion, picked.intensity);
          console.log("[chat] chat-only opinion", {
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
          recordEvent(sid, "chat_deterministic", { kind: "opinion_query", topic: resolvedTopic });
          return res.json({ reply, emotion: picked.emotion, intensity: picked.intensity, proposed: [], meta: { affect } });
        }

        // If the user expresses a preference about the last topic, allow Piper to shift slightly.
        const pref = parseUserPreferenceSignal2(msg);
        const reason = extractReasonClause2(msg);
        if (pref && resolvedTopic && opinion) {
          const shifted = adjustOpinionTowardUser(resolvedTopic, pref.signal, reason);
          if (shifted) {
            opinion = shifted;
            opinionScore = shifted.score ?? opinionScore;
          }
        }

        // Deterministic follow-up handling:
        // If the user says "I don't like it" (or similar) right after an opinion topic,
        // respond directly without an LLM call for better coherence + speed.
        if (pref && resolvedTopic && opinion && isLikelyPreferenceFollowup(msg)) {
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

          reply = maybeAddExplicitSelfReport(enforcePiper(reply), picked.emotion, picked.intensity);

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
          recordEvent(sid, "chat_deterministic", { kind: "pref_followup", topic });
          return res.json({ reply, emotion: picked.emotion, intensity: picked.intensity, proposed: [], meta: { affect } });
        }

        // Deterministic opinion answers (prevents "I can't have opinions" leakage)
        if (resolvedTopic && isOpinionQuery2(msg) && isOpinionWorthyTopic(resolvedTopic) && opinion) {
          const picked = pickEmotion({ msg, affect, opinionScore, disagreeLevel, authorityOverride });
          let reply = enforcePiper(deterministicOpinionReply(resolvedTopic, opinion));
          reply = maybeAddExplicitSelfReport(reply, picked.emotion, picked.intensity);
          console.log("[chat] chat-only opinion", {
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
          recordEvent(sid, "chat_deterministic", { kind: "opinion_query", topic: resolvedTopic });
          return res.json({ reply, emotion: picked.emotion, intensity: picked.intensity, proposed: [], meta: { affect } });
        }

        // Persuasion attempts about the last topic ("you should like it because...")
        const persu = parsePersuasionAttempt(msg);
        if (persu && !pref) {
          const lastKey = getLastOpinionKey(sid);
          const lastTopic = lastKey && lastKey.startsWith("topic:") ? lastKey.slice(6) : null;
          const topic = lastTopic || resolvedTopic;
          if (topic) {
            const why = extractReasonClause2(msg);
            const shifted = adjustOpinionTowardUser(topic, persu.signal, why);
            if (shifted) {
              const picked = pickEmotion({ msg, affect, opinionScore: shifted.score, disagreeLevel, authorityOverride });
              let reply = enforcePiper(
                `Fair point. On ${topic}, I'm shifting slightly in your direction — ${shifted.stance === "like" ? "more favorable" : "more cautious"}.` +
                  (why ? ` Reason noted: ${why}` : "")
              );
              reply = maybeAddExplicitSelfReport(reply, picked.emotion, picked.intensity);
              console.log("[mind] persuasion", { sid, topic, signal: persu.signal, reason: why });
              pushConversationTurn(sid, "assistant", reply);
              return res.json({ reply, emotion: picked.emotion, intensity: picked.intensity, proposed: [], meta: { affect } });
            }
          }
        }

        const raw = await callOllama(buildChatMessages({ userMsg: msg, affect, disagreeLevel, authorityOverride, opinion, history: getConversationMessages(sid), lastTopic: getLastOpinionKey(sid) }), {
          model: process.env.OLLAMA_MODEL || "llama3.1",
        });

        recordEvent(sid, "llm_success", { mode: "chat" });

        const picked = pickEmotion({ msg, affect, opinionScore, disagreeLevel, authorityOverride });
        let reply = enforcePiper(raw || "…");
        reply = maybeAddExplicitSelfReport(reply, picked.emotion, picked.intensity);

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
        return res.json({ reply, emotion: picked.emotion, intensity: picked.intensity, proposed: [], meta: { affect } });
      } catch (e) {
        recordEvent(sid, "llm_fail", { mode: "chat", error: String(e?.message || e) });
        console.log("[chat] chat-only ERROR", { sid, err: String(e?.message || e) });
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

        const strong = maybeDeterministicStrongDisagree(msg, disagreeLevel, authorityOverride);
        if (strong) {
          recordEvent(sid, "chat_deterministic", { kind: "strong_disagree", mode: "chat" });
          const reply = maybeAddExplicitSelfReport(enforcePiper(strong), "serious", 0.7);
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
        return res.json({ reply, emotion: "serious", intensity: 0.7, proposed: [], meta: { affect } });
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
          if (lastKey && lastKey.startsWith("topic:")) resolvedTopic = lastKey.slice(6);
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
          const shifted = adjustOpinionTowardUser(resolvedTopic, pref.signal, reason);
          if (shifted) {
            opinion = shifted;
            opinionScore = shifted.score ?? opinionScore;
          }
        }

        // Deterministic follow-up handling (same as chat-only path)
        if (pref && resolvedTopic && opinion && isLikelyPreferenceFollowup(msg)) {
          recordEvent(sid, "opinion_followup", { topic: opinion.key, signal: pref.signal });
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
          reply = maybeAddExplicitSelfReport(reply, picked.emotion, picked.intensity);

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
          return res.json({ reply, emotion: picked.emotion, intensity: picked.intensity, proposed: [], meta: { affect } });
        }

        const raw = await callOllama(buildChatMessages({ userMsg: msg, affect, disagreeLevel, authorityOverride, opinion, history: getConversationMessages(sid), lastTopic: getLastOpinionKey(sid) }), {
          model: process.env.OLLAMA_MODEL || "llama3.1",
        });

        recordEvent(sid, "llm_success", { mode: "chat" });

        const picked = pickEmotion({ msg, affect, opinionScore, disagreeLevel, authorityOverride });
        let reply = enforcePiper(raw || "…");
        reply = maybeAddExplicitSelfReport(reply, picked.emotion, picked.intensity);

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
        return res.json({ reply, emotion: picked.emotion, intensity: picked.intensity, proposed: [], meta: { affect } });
      }

      // --- PLAN / CHANGE ---
      const snapshot = await buildSnapshot({ message: msg, lastIntent: sessions.get(sid)?.lastIntent || "chat" });

      const planned = await llmRespondAndPlan({
        message: msg,
        snapshot,
        lastIntent: sessions.get(sid)?.lastIntent || "chat",
      });

      const compiled = compilePlanToActions(planned, snapshot);

      const proposed = [];
      for (const a of compiled.actions || []) {
        const id = addAction(a);
        proposed.push({ id, ...a.summary });
      }

      sessions.set(sid, { lastIntent: "change" });
      setLastIntent(sid, "change", msg);

      // Task success if we proposed actions, else neutral
      recordEvent(sid, "task_success", { proposed: proposed.length });

      const affect = getAffectSnapshot(sid);
      const picked = pickEmotion({ msg, affect, opinionScore: null, disagreeLevel: 0, authorityOverride: false });

      console.log("[chat] plan", {
        sid,
        ms: Date.now() - started,
        proposed: proposed.length,
        mood: affect.mood,
        fr: affect.frustration.total,
      });

      return res.json({
        reply: enforcePiper(planned.reply || "Understood, sir."),
        emotion: picked.emotion,
        intensity: picked.intensity,
        proposed,
        meta: { affect },
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
