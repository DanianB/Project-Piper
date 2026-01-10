// src/routes/chat/handler.js
import crypto from "crypto";
import { callOllama } from "../../services/ollama.js";
import { enforcePiper, piperSystemPrompt } from "../../services/persona.js";

import { triageNeedsPlanner } from "../../planner/triage.js";
import { buildSnapshot } from "../../planner/snapshot.js";
import { llmRespondAndPlan } from "../../planner/planner.js";
import { compilePlanToActions } from "../../planner/compiler.js";
import { logRunEvent } from "../../utils/runlog.js";

import {
  runWebContext,
  extractWebSources,
  packSourcesForUi,
} from "../../services/web/webContext.js";

import { listTools } from "../../tools/index.js";
import { toolRegistry, ToolRisk } from "../../tools/registry.js";

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
} from "../../services/mind.js";

import {
  readAppsAllowlist,
  listAllowlistedAppIds,
  isListAppsIntent,
  parseOpenAllowlistedApp,
} from "./parsers/apps.js";
import {
  parseOpenDesktopFolder,
  parseWriteTextInThere,
  getLastOpenedFolder,
  setLastOpenedFolder,
} from "./parsers/filesystem.js";
import { isGreeting, isRestartRequest, isTitleRequest } from "./parsers/conversation.js";
import { isWebSearchIntent, extractWebQuery } from "./parsers/web.js";
import {
  isOpinionQuery,
  extractOpinionTopic,
  parseUserPreferenceSignal,
  extractReasonClause,
  isLikelyPreferenceFollowup,
} from "./parsers/opinions.js";

import { shouldAllowActions, reqMeta } from "./policies/actions.js";
import {
  isAuthorityOverride,
  computeDisagreeLevel,
  maybeDeterministicStrongDisagree,
} from "./policies/authority.js";

import { newId } from "./utils/ids.js";
import { logMode } from "./utils/logMode.js";
import { clamp01, pickEmotion } from "./utils/emotion.js";

import { handleTitleRequest } from "./workflows/titleFlow.js";
import { buildChatMessages } from "./workflows/messages.js";
import { addPendingAction } from "./workflows/pendingActions.js";
import { maybeAddExplicitSelfReport } from "./workflows/selfReport.js";

export async function chatHandler(req, res) {

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
    return res.json({ reply, emotion: "warm", intensity: 0.45, proposed: [], meta: { affect } });
  }

  // Open allowlisted app
  const openApp = parseOpenAllowlistedApp(msg);
  if (openApp) {
    const affect = getAffectSnapshot(sid);
    const action = addPendingAction({ type: openApp.type, title: openApp.title, reason: openApp.reason, payload: openApp.payload });
    console.log("[phase3] propose_action", { sid, id: action?.id, type: action?.type, title: action?.title });
    const reply = enforcePiper(`Proposed: open ${openApp.payload.appId}. Approve to execute.`);
    logMode(sid, "approval_action", { kind: "launch_app", appId: openApp.payload.appId });
    return res.json({ reply, emotion: "warm", intensity: 0.45, proposed: [action], meta: { affect } });
  }

  // Open Desktop folder (various phrasings)
  const desk = parseOpenDesktopFolder(msg);
  if (desk) {
    const affect = getAffectSnapshot(sid);
    const action = addPendingAction({ type: desk.type, title: desk.title, reason: desk.reason, payload: desk.payload });
    setLastOpenedFolder(sid, desk._folderPath);
    console.log("[phase3] propose_action", { sid, id: action?.id, type: action?.type, title: action?.title, path: desk._folderPath });
    const reply = enforcePiper(`Proposed: open the "${desk._folderName}" folder on your Desktop. Approve to execute.`);
    logMode(sid, "approval_action", { kind: "open_path", path: desk._folderPath });
    return res.json({ reply, emotion: "warm", intensity: 0.45, proposed: [action], meta: { affect } });
  }

  // Write a text document "in there" (last opened folder)
  const wt = parseWriteTextInThere(msg);
  if (wt) {
    const affect = getAffectSnapshot(sid);
    const folder = getLastOpenedFolder(sid);
    if (!folder) {
      const reply = enforcePiper('Which folder do you mean, sir? Open the folder first, then say "put a text document in there...".');
      return res.json({ reply, emotion: "neutral", intensity: 0.4, proposed: [], meta: { affect } });
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
    return res.json({ reply, emotion: "warm", intensity: 0.45, proposed: [action], meta: { affect } });
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

// Phase 2.1: web search in chat-only mode (read-only tools allowed even when actions are disabled)
let preToolResults = [];
let webContext = null;
if (isWebSearchIntent(msg)) {
  const q = extractWebQuery(msg);
  const ran = await runWebContext(q, sid);
  preToolResults = ran.ran || [];
  webContext = ran.fetchedText || null;
}

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
            meta: { affect },
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
          meta: { affect },
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
            meta: { affect },
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
            meta: { affect },
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
          meta: { affect },
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
            meta: { affect },
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
            meta: { affect },
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
}
