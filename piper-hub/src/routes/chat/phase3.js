// src/routes/chat/phase3.js
// Phase 3 deterministic intents extracted from routes/chat.js to reduce cascade risk.
// Handles:
//  - list allowlisted apps
//  - open Desktop folder (auto-execute)
//  - open/launch allowlisted app (auto-execute)
//  - write text file in last-opened folder (approval-gated)

import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

import { callOllama } from "../../services/ollama.js";
import { enforcePiper } from "../../services/persona.js";

import { addAction, updateAction } from "../../actions/store.js";
import { executeAction } from "../../actions/executor.js";
import { logRunEvent } from "../../utils/runlog.js";

// Remember the last folder the user explicitly opened (per session)
// Used for "put a text document in there" style references.
const lastOpenedPathBySid = new Map();

const APPS_FILE = path.join(process.cwd(), "data", "apps.json");

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function loadAllowlistedApps() {
  try {
    if (!fs.existsSync(APPS_FILE)) return {};
    const raw = fs.readFileSync(APPS_FILE, "utf8");
    const obj = safeParseJson(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function isListAppsRequest(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    s === "list apps" ||
    s === "list app" ||
    s.includes("what apps can you open") ||
    s.includes("what apps can you launch") ||
    s.includes("which apps can you open") ||
    s.includes("which apps can you launch") ||
    s.includes("can you list apps")
  );
}

function sanitizeTarget(raw) {
  return String(raw || "")
    .replace(/["'`]/g, "")
    .replace(/[()\[\]{}]/g, " ")
    .replace(/[\.,!?;:]+$/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseDesktopFolderOpen(msg) {
  // Examples we should accept:
  //  - "open the worms folder on my desktop"
  //  - "please open the worms folder on the desktop"
  //  - "open worms on desktop"
  //  - "open the desktop worms folder"
  // tolerate common typos: deskop / desktp / destkop
  const s = String(msg || "");

  const desktopWord = "desk(?:top|op|tp|tok?p)";
  const openWord = "(?:open|show|launch)";
  const polite = "(?:please\s+)?";

  // Pattern A: "open <name> folder on (my|the) desktop"
  let m = new RegExp(`${polite}${openWord}\\s+(?:the\\s+)?(.+?)\\s+(?:folder\\s+)?on\\s+(?:(?:my|the)\\s+)?${desktopWord}\\b`, "i").exec(s);

  // Pattern B: "open <name> on desktop"
  if (!m) {
    m = new RegExp(`${polite}${openWord}\\s+(?:the\\s+)?(.+?)\\s+on\\s+${desktopWord}\\b`, "i").exec(s);
  }

  // Pattern C: "open the desktop <name> folder"
  if (!m) {
    m = new RegExp(`${polite}${openWord}\\s+(?:the\\s+)?${desktopWord}\\s+(.+?)\\s+folder\\b`, "i").exec(s);
  }

  if (!m) return null;

  const name = String(m[1] || "").trim().replace(/^["“”']|["“”']$/g, "");
  if (!name) return null;

  const desktop = path.join(os.homedir(), "Desktop");
  const p = path.join(desktop, name);
  return { folderName: name, path: p };
}

function resolveDesktopFolderPath(folderName) {
  const name = String(folderName || "").trim().replace(/^"|"$/g, "");
  if (!name) return null;
  const desktop = path.join(os.homedir(), "Desktop");
  return path.join(desktop, name);
}

function parseWriteTextFileRequest(msg) {
  const s = String(msg || "").trim();

  // Must mention a write-like verb and a text/txt file.
  if (!/\b(?:put|create|write|make|generate)\b/i.test(s)) return null;
  if (!/\b(?:txt|text)\b/i.test(s)) return null;

  // 1) Folder name, if explicitly provided (e.g. "in the worms folder")
  let folderName = null;
  const fm =
    /\b(?:in|inside|within)\s+(?:the\s+)?["“”']?([^"“”'\n]+?)["“”']?\s+folder\b/i.exec(s);
  if (fm) folderName = String(fm[1] || "").trim();

  // 2) Filename (prefer quoted)
  let filename = null;

  // Prefer: called/named "<name>"
  const q1 =
    /\b(?:called|named)\b\s*["“”']([^"“”']{1,120})["“”']/i.exec(s);
  if (q1) filename = q1[1].trim();

  // Next: any quoted string if it looks like a filename request
  if (!filename) {
    const anyQ = /["“”']([^"“”']{1,120})["“”']/i.exec(s);
    if (anyQ && /\b(?:called|named|file|document)\b/i.test(s)) filename = anyQ[1].trim();
  }

  // Finally: unquoted after called/named (take up to end or before "that/which/to/and" clause)
  if (!filename) {
    const um =
      /\b(?:called|named)\b\s+([^\n]+)$/i.exec(s);
    if (um) {
      filename = um[1]
        .replace(/\b(?:that|which|who|to|and)\b[\s\S]*$/i, "")
        .trim();
    }
  }

  if (!filename) return null;

  // Clean filename
  filename = filename
    .replace(/\.(txt|text)$/i, "") // we'll append .txt later
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!filename) return null;

  // 3) Content request: anything after "that ..." or "describ(es/ing) ..."
  let contentRequest = null;
  const cm =
    /\b(?:that\s+)?(?:describes?|describing|about|with)\b\s+([\s\S]{5,})$/i.exec(s);
  if (cm) contentRequest = String(cm[1] || "").trim();

  return { filename, folderName, contentRequest };
}

function makeAction({ sid, type, title, reason, payload, risk = "action" }) {
  const id = crypto.randomUUID ? `act_${crypto.randomUUID()}` : `act_${crypto.randomBytes(8).toString("hex")}`;
  const now = Date.now();
  return { id, sid, type, title, reason, payload, risk, status: "pending", createdAt: now, updatedAt: now };
}

function actionsDisabledReply(res, affect) {
  return res.json({
    reply: enforcePiper("Actions are disabled in this request, sir."),
    emotion: "neutral",
    intensity: 0.4,
    proposed: [],
    meta: { affect },
  });
}

async function executeLowRisk({ res, sid, action, replyText, affect }) {
  addAction(action);
  console.log("[phase3] propose_action", { sid, id: action.id, type: action.type, title: action.title });
  logRunEvent({ kind: "phase3_propose", sid, id: action.id, type: action.type });

  try {
    await executeAction(action);
    updateAction(action.id, { status: "done", updatedAt: Date.now() });
  } catch (e) {
    updateAction(action.id, { status: "failed", error: String(e?.message || e), updatedAt: Date.now() });
    return res.json({
      reply: enforcePiper(`That failed: ${String(e?.message || e)}`),
      emotion: "concerned",
      intensity: 0.55,
      proposed: [],
      meta: { affect },
    });
  }

  return res.json({
    reply: enforcePiper(replyText),
    emotion: "warm",
    intensity: 0.45,
    proposed: [],
    meta: { affect },
  });
}

function proposeActionAndRespond({ res, sid, actions, reply, affect, emotion = "warm", intensity = 0.45 }) {
  const safeActions = (Array.isArray(actions) ? actions : []).filter(Boolean);

  if (!safeActions.length) {
    console.log("[phase3] propose_action", { sid, count: 0 });
    return res.json({
      reply: enforcePiper(reply || "Understood, sir."),
      emotion,
      intensity,
      proposed: [],
      meta: { affect },
    });
  }

  for (const a of safeActions) addAction(a);

  console.log("[phase3] propose_action", {
    sid,
    id: safeActions[0]?.id,
    type: safeActions[0]?.type,
    title: safeActions[0]?.title,
    count: safeActions.length,
  });
  logRunEvent({ kind: "phase3_propose", sid, id: safeActions[0]?.id, type: safeActions[0]?.type });

  return res.json({
    reply: enforcePiper(reply || "Understood, sir."),
    emotion,
    intensity,
    proposed: safeActions,
    meta: { affect },
  });
}

export async function handlePhase3Deterministic({ req, res, sid, msg, affect, allowActions, logIntent }) {
  const text = String(msg || "");

  if (isListAppsRequest(text)) {
    logIntent("list_apps");
    const apps = loadAllowlistedApps();
    const ids = Object.keys(apps || {});
    const list = ids.length ? ids.join(", ") : "(none)";
    return res.json({
      reply: enforcePiper(
        ids.length
          ? `I can open these allowlisted apps: ${list}. Say "open <app>" (e.g., "open vscode").`
          : "No allowlisted apps are configured right now, sir."
      ),
      emotion: "warm",
      intensity: 0.45,
      proposed: [],
      meta: { affect },
    });
  }

  const df = parseDesktopFolderOpen(text);
  if (df) {
    logIntent("open_desktop_folder", { folder: df.folderName });
    if (!allowActions) return actionsDisabledReply(res, affect);

    lastOpenedPathBySid.set(sid, df.path);

    const action = makeAction({
      sid,
      type: "open_path",
      title: `Open Desktop folder: ${df.folderName}`,
      reason: `User asked to open a Desktop folder (${df.folderName}).`,
      payload: { path: df.path },
      risk: "action",
    });

    await executeLowRisk({ res, sid, action, replyText: `Opening the "${df.folderName}" folder on your Desktop.`, affect });
    return true;
  }

  const mOpen = text.match(/^\s*(open|launch|start|run)\s+(.+?)\s*$/i);
  if (mOpen) {
    const raw = mOpen[2];
    const target = sanitizeTarget(raw);
    logIntent("open_or_launch", { targetRaw: raw, target });
    if (!allowActions) return actionsDisabledReply(res, affect);

    const apps = loadAllowlistedApps();
    const ids = Object.keys(apps || {});
    const hit = ids.find((id) => String(id).toLowerCase() === target);

    const soft = (() => {
      const t = text.toLowerCase();
      if (/\b(music|song|songs|playlist|spotify|tunes|play\s+some\s+music)\b/.test(t)) return "spotify";
      if (/\b(game|games|steam)\b/.test(t)) return "steam";
      if (/\b(code|coding|program|vscode|vs\s*code)\b/.test(t)) return "vscode";
      return null;
    })();
    const softHit = soft ? ids.find((id) => String(id).toLowerCase() === soft) : null;

    const appId = hit || softHit;
    if (!appId) {
      return res.json({
        reply: enforcePiper(
          ids.length
            ? `Which app do you mean, sir? I can open: ${ids.join(", ")}.`
            : "I don't have any allowlisted apps configured yet, sir."
        ),
        emotion: "neutral",
        intensity: 0.4,
        proposed: [],
        meta: { affect },
      });
    }

    const action = makeAction({
      sid,
      type: "launch_app",
      title: `Launch app: ${appId}`,
      reason: `User asked to open ${appId}.`,
      payload: { appId, args: [] },
      risk: "action",
    });

    await executeLowRisk({ res, sid, action, replyText: `Opening ${appId} for you.`, affect });
    return true;
  }

  const wf = parseWriteTextFileRequest(text);
  if (wf) {
    logIntent("write_text_file_request", { filename: wf.filename, inFolder: wf.folderName || null });
    if (!allowActions) return actionsDisabledReply(res, affect);

    let baseFolder = null;
    if (wf.folderName) {
      const desk = resolveDesktopFolderPath(wf.folderName);
      if (desk) baseFolder = desk;
    }
    if (!baseFolder) baseFolder = lastOpenedPathBySid.get(sid);

    if (!baseFolder) {
      return res.json({
        reply: enforcePiper('Which folder do you mean, sir? Open the folder first, then say "put a txt file in there called ...".'),
        emotion: "neutral",
        intensity: 0.4,
        proposed: [],
        meta: { affect },
      });
    }

    const filename = wf.filename.toLowerCase().endsWith(".txt") ? wf.filename : `${wf.filename}.txt`;
    const fullPath = path.join(baseFolder, filename);

    const contentPrompt = wf.contentRequest || `Create a concise plain-text file titled "${filename}" based on: ${text.trim()}`;

    const genText = await callOllama(
      [
        {
          role: "system",
          content:
            "You are Piper. Generate ONLY the plain text content for a .txt file. No markdown fences, no preamble, no 'here is the file'.",
        },
        { role: "user", content: contentPrompt },
      ],
      { temperature: 0.6 }
    );

    const content = String(genText || "").trim();

    const action = makeAction({
      sid,
      type: "write_text_file",
      title: `Create file: ${filename}`,
      reason: "User asked to create a text file in the referenced folder.",
      payload: { path: fullPath, content },
      risk: "action",
    });

    action.preview = content.slice(0, 600);

    proposeActionAndRespond({
      res,
      sid,
      actions: [action],
      reply: `Proposed: create "${filename}" in that folder. Approve to execute.`,
      affect,
      emotion: "warm",
      intensity: 0.45,
    });
    return true;
  }

  return false;
}
