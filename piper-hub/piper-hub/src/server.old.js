// server.js (ESM) — Piper Hub (Windows)
// Option B (recommended):
// - No Dev Mode toggle.
// - A small intent classifier decides when to propose approval-gated actions.
// - One safety toggle remains: readOnly=true => NEVER propose actions.
//
// Features:
// - /ping instance verification
// - /chat: app commands OR chat OR propose upgrades (approval-gated)
// - Actions: approve/reject/rollback
// - Voice STT: /voice/transcribe (ffmpeg -> whisper.cpp)
// - Voice TTS: /voice/speak (piper.exe -> wav -> SoundPlayer PlaySync), serialized queue
// - /shutdown: exits with OFF code (99) so supervisor stops restarting

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { exec, spawn } from "child_process";

const PORT = Number(process.env.PORT || 3000);
const OFF_EXIT_CODE = 99;
const ROOT = process.cwd();

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(ROOT, "public")));

if (typeof fetch !== "function") {
  console.error("❌ Node fetch() not available. Install Node 18+.");
  process.exit(1);
}

// -------------------- Directories --------------------
const DATA_DIR = path.join(ROOT, "data");
const TMP_DIR = path.join(ROOT, "tmp");
const ACTIONS_DIR = path.join(ROOT, "actions");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(ACTIONS_DIR, { recursive: true });

const ACTIONS_FILE = path.join(DATA_DIR, "actions.json");
const APPS_FILE = path.join(DATA_DIR, "apps.json");
const OFF_FLAG_PATH = path.join(DATA_DIR, "OFF.flag");

// -------------------- PATHS (edit if needed) --------------------
// These are your known-good locations.
const FFMPEG_EXE =
  "C:\\Users\\Danian\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe";

const WHISPER_EXE = "D:\\AI\\whisper\\whisper-cli.exe";
const WHISPER_MODEL = "D:\\AI\\whisper\\models\\ggml-base.en.bin"; // can swap to tiny for speed
const WHISPER_THREADS = 6;

// Your TTS folder (you said this is correct)
const PIPER_EXE = "D:\\AI\\piper-tts\\piper.exe";
const PIPER_VOICE = "D:\\AI\\piper-tts\\voices\\en_US-amy-medium.onnx";

// Server-owned temp outputs (avoid writing inside piper-tts)
const TMP_PIPER_TEXT = path.join(TMP_DIR, "piper_text.txt");
const TMP_PIPER_WAV = path.join(TMP_DIR, "piper_out.wav");

// Quick sanity logs
console.log("[boot]", {
  ROOT,
  PORT,
  FFMPEG_EXE,
  WHISPER_EXE,
  WHISPER_MODEL,
  PIPER_EXE,
  PIPER_VOICE,
  TMP_DIR,
});

// -------------------- Server + sockets (true port release) --------------------
let server;
const sockets = new Set();

// -------------------- Upload --------------------
const upload = multer({ storage: multer.memoryStorage() });

// -------------------- Sessions --------------------
const sessions = new Map(); // sessionId -> { turns }

// -------------------- Devices --------------------
const devices = new Map();

// -------------------- Actions persistence --------------------
let actions = [];
loadActions();

function loadActions() {
  try {
    if (!fs.existsSync(ACTIONS_FILE)) {
      actions = [];
      return;
    }
    const j = JSON.parse(fs.readFileSync(ACTIONS_FILE, "utf8"));
    actions = Array.isArray(j) ? j : [];
  } catch {
    actions = [];
  }
}
function saveActions() {
  try {
    fs.writeFileSync(ACTIONS_FILE, JSON.stringify(actions, null, 2), "utf8");
  } catch (e) {
    console.error("[actions] save failed", e);
  }
}
function addAction(a) {
  actions.push(a);
  saveActions();
  return a;
}
function nowIso() {
  return new Date().toISOString();
}
function nowId(prefix = "act") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

// -------------------- Apps registry --------------------
function loadApps() {
  try {
    if (!fs.existsSync(APPS_FILE)) return {};
    const j = JSON.parse(fs.readFileSync(APPS_FILE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

// -------------------- Command parsing (open/launch/play) --------------------
function parseOpenCommand(text) {
  const m = String(text || "").match(
    /\b(open|launch|start|play)\b(?:\s+up)?\s+(.+?)(?:\s+on\s+(my\s+)?(.+))?$/i
  );
  if (!m) return null;
  return {
    appName: (m[2] || "").trim().toLowerCase(),
    target: (m[4] || "").trim().toLowerCase(),
  };
}
function pickDeviceIdFromTarget(targetPhrase) {
  if (!targetPhrase) return null;
  const t = targetPhrase.toLowerCase();
  if (t.includes("laptop") || t.includes("linux")) return "laptop";
  if (t.includes("pc") || t.includes("computer") || t.includes("windows"))
    return "pc";
  return null;
}
function resolveAppKey(appName, apps) {
  if (!appName) return null;
  if (apps[appName]) return appName;

  const aliases = {
    "vs code": "vscode",
    "visual studio code": "vscode",
    "microsoft edge": "edge",
  };
  if (aliases[appName] && apps[aliases[appName]]) return aliases[appName];

  const keys = Object.keys(apps);
  const hit = keys.find((k) => appName.includes(k));
  return hit || null;
}
function openAppLocal(appKey, apps) {
  const target = apps[appKey];
  if (!target) return { ok: false, message: `I can’t find "${appKey}".` };

  exec(`cmd.exe /c start "" "${target}"`, { windowsHide: true }, (err) => {
    if (err) console.error("[openAppLocal]", err);
  });

  return { ok: true, message: `Got it — opening ${appKey}.` };
}

// -------------------- Restart / Off intent --------------------
function looksLikeRestartRequest(m) {
  const s = String(m || "").toLowerCase();
  return (
    /\brestart\b/.test(s) ||
    /\breset\b/.test(s) ||
    /\breboot\b/.test(s) ||
    (s.includes("restart") && s.includes("yourself"))
  );
}
function looksLikeOffRequest(m) {
  const s = String(m || "").toLowerCase();
  return (
    /\bturn\s+off\b/.test(s) ||
    /\bshutdown\b/.test(s) ||
    /\bshut\s+down\b/.test(s) ||
    (s.includes("power") && s.includes("off"))
  );
}

// -------------------- Ollama (timeouts, stable) --------------------
async function callOllama(messages, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  try {
    const r = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama3", messages, stream: false }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Ollama HTTP ${r.status}: ${txt.slice(0, 300)}`);
    }
    const j = await r.json();
    return j.message?.content || "";
  } catch (e) {
    if (e && e.name === "AbortError") {
      const err = new Error(`OLLAMA_TIMEOUT_${timeoutMs}`);
      err.code = "OLLAMA_TIMEOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// -------------------- Persona enforcement --------------------
const USER_NAME = "Danian";
const PERSONA = {
  maxReplySentences: 3,
  maxSpokenChars: 360,
  nameEveryNTurns: 12,
  sirChance: 0.28,
  witChance: 0.1,
};

function maybeDryTag(turns) {
  if (Math.random() > PERSONA.witChance) return "";
  if (turns < 2 && Math.random() < 0.7) return "";
  const tags = [
    "As you wish.",
    "If you insist.",
    "Naturally.",
    "Consider it done.",
  ];
  return tags[Math.floor(Math.random() * tags.length)];
}
function isSerious(text) {
  const t = String(text || "").toLowerCase();
  return /\b(suicide|self-harm|kill myself|hurt myself|abuse|assault|rape|panic|overdose|chest pain|stroke|emergency)\b/.test(
    t
  );
}
function buildSystemPrompt({ turns, serious }) {
  const dry = serious ? "" : maybeDryTag(turns);

  let sys =
    "You are Piper — calm, capable, Jarvis-style. Confident, concise, lightly witty. Never bubbly. Never verbose.\n\n" +
    "Hard rules:\n" +
    "- Do NOT say 'Windows', 'PC', 'computer', 'hub', 'deviceId', or explain your setup unless asked.\n" +
    "- Do NOT say 'I am an AI' or 'helpful AI assistant'.\n" +
    "- If greeted, greet briefly and move on; do not reintroduce yourself.\n\n" +
    `Default length: ${PERSONA.maxReplySentences} short sentences.\n` +
    "Use 'sir' occasionally (not every reply). Use the user's name rarely, never as a standalone word.\n\n";

  if (serious)
    sys +=
      "If the user seems distressed or mentions harm, drop wit entirely and respond supportively and directly.\n\n";
  if (dry) sys += `Optional dry tag (rare): '${dry}'\n\n`;

  sys += "Your name is Piper. Never rename yourself.\n";
  return sys;
}
function enforceJarvis(text) {
  let t = String(text || "").trim();
  if (!t) return "…";
  t = t.replace(/\b(as an ai|language model|system prompt)\b/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  const parts = t.split(/(?<=[.!?])\s+/);
  return parts.slice(0, PERSONA.maxReplySentences).join(" ") || t;
}
function makeSpoken(text) {
  let t = enforceJarvis(text)
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  if (t.length > PERSONA.maxSpokenChars)
    t = t.slice(0, PERSONA.maxSpokenChars).trim() + "…";
  return t;
}

// -------------------- Intent classifier (Option B) --------------------
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function extractFirstJsonObject(s) {
  s = String(s || "").trim();
  const direct = safeJsonParse(s);
  if (direct) return direct;

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return safeJsonParse(s.slice(start, end + 1));
  }
  return null;
}

async function classifyIntent(message) {
  // mode: "chat"|"propose"
  const sys =
    "You are an intent classifier for a local assistant.\n" +
    "Decide if the user is requesting a change/upgrade to the system (code, UI, features, integrations, bug fixes, refactors, automation) that should require approval.\n" +
    "If yes => mode='propose'. Otherwise => mode='chat'.\n" +
    "Output ONLY valid JSON with keys: mode, confidence, reason.\n" +
    "confidence is a number 0..1.\n" +
    "No extra text.";

  const out = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: String(message || "") },
    ],
    { timeoutMs: 8000 }
  );

  const j = extractFirstJsonObject(out) || {};
  const mode = j.mode === "propose" || j.mode === "chat" ? j.mode : "chat";
  const confidence = typeof j.confidence === "number" ? j.confidence : 0.5;
  const reason = typeof j.reason === "string" ? j.reason : "";
  return { mode, confidence, reason };
}

// -------------------- Level 3 UI Grounding (deterministic) --------------------
function normalizeWs(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseButtonsFromHtml(html) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || "";
    const inner = m[2] || "";
    const text = normalizeWs(inner.replace(/<[^>]+>/g, ""));
    const classMatch = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/i);
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const classes = classMatch
      ? classMatch[1].split(/\s+/).filter(Boolean)
      : [];
    out.push({
      text,
      id: idMatch ? idMatch[1] : "",
      type: typeMatch ? typeMatch[1] : "",
      classes,
      outer: `<button${attrs}>${inner}</button>`,
    });
  }
  return out;
}

// Small CSS block extractor: selector { ... } (simple, no deps)
function parseCssBlocks(css) {
  const blocks = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;

    let selEnd = open;
    let selStart = css.lastIndexOf("}", open);
    selStart = selStart === -1 ? 0 : selStart + 1;

    const selector = normalizeWs(css.slice(selStart, selEnd));

    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= css.length) break;

    const body = css.slice(open + 1, j);
    blocks.push({
      selector,
      full: css.slice(selStart, j + 1), // exact substring for apply_patch find
      body,
    });
    i = j + 1;
  }
  return blocks;
}

function findCssBlock(blocks, selector) {
  const target = normalizeWs(selector);
  return blocks.find((b) => normalizeWs(b.selector) === target) || null;
}

function detectColorIntent(message) {
  const msg = String(message || "");
  const lower = msg.toLowerCase();

  if (!/\bbutton\b/.test(lower)) return null;

  const hex = lower.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i)?.[0] || "";
  const named =
    lower.match(
      /\b(blue|red|green|teal|cyan|orange|yellow|purple|pink|white|black|gray|grey)\b/i
    )?.[1] || "";
  const color = hex || named;
  if (!color) return null;

  const mentionsSend = /\bsend\b/.test(lower);
  return { color, mentionsSend };
}

function buildCssBackgroundPatch(stylesCss, selector, color) {
  const blocks = parseCssBlocks(stylesCss);
  const block = findCssBlock(blocks, selector);
  if (!block) return null;

  const full = block.full;
  let newFull = full;

  if (/\bbackground-color\s*:/.test(block.body)) {
    newFull = full.replace(
      /\bbackground-color\s*:\s*[^;]+;/,
      `background-color: ${color};`
    );
  } else if (/\bbackground\s*:/.test(block.body)) {
    newFull = full.replace(
      /\bbackground\s*:\s*[^;]+;/,
      `background: ${color};`
    );
  } else {
    newFull = full.replace("{", `{\n  background-color: ${color};`);
  }

  if (newFull === full) return null;

  return {
    type: "apply_patch",
    title: `Set ${selector} background to ${color}`,
    reason: `Grounded change: matched actual HTML button -> CSS selector -> exact CSS block.`,
    payload: {
      path: "public/styles.css",
      edits: [{ find: full, replace: newFull, mode: "once" }],
    },
  };
}

function groundedUiPlan(message, indexHtml, stylesCss) {
  const intent = detectColorIntent(message);
  if (!intent) return null;

  const buttons = parseButtonsFromHtml(indexHtml);
  const cssBlocks = parseCssBlocks(stylesCss);

  let targetBtn = null;

  // Prefer exact Send button
  if (intent.mentionsSend) {
    targetBtn =
      buttons.find((b) => (b.text || "").toLowerCase() === "send") || null;
  }

  // Fallback: if exactly one submit button exists, use it
  if (!targetBtn) {
    const submitBtns = buttons.filter(
      (b) => (b.type || "").toLowerCase() === "submit"
    );
    if (submitBtns.length === 1) targetBtn = submitBtns[0];
  }

  if (!targetBtn) return null;

  // Prefer a class selector that actually exists in CSS
  const classSelectors = (targetBtn.classes || []).map((c) => `.${c}`);
  const selector =
    classSelectors.find((sel) => findCssBlock(cssBlocks, sel)) || "";
  if (!selector) return null;

  const action = buildCssBackgroundPatch(stylesCss, selector, intent.color);
  if (!action) return null;

  return {
    reply: "Understood. I’ve queued a reviewable change for approval.",
    proposed: [action],
  };
}

async function proposeActions(message) {
  // File-aware planner with MUST-propose + safe fallback diagnostics.
  const wantUi =
    /layout|ui|css|style|theme|color|button|send button|screen|panel|right side|left side|move|position|recent actions|history|overflow|scroll/i.test(
      String(message || "")
    );

  let indexHtml = "";
  let stylesCss = "";

  try {
    if (wantUi) {
      const ixPath = path.join(ROOT, "public", "index.html");
      const cssPath = path.join(ROOT, "public", "styles.css");
      indexHtml = fs.existsSync(ixPath) ? fs.readFileSync(ixPath, "utf8") : "";
      stylesCss = fs.existsSync(cssPath)
        ? fs.readFileSync(cssPath, "utf8")
        : "";
    }
  } catch {}
  // LEVEL 3: deterministic grounded plan first (read actual HTML/CSS, then patch)
  if (wantUi && indexHtml && stylesCss) {
    const grounded = groundedUiPlan(
      String(message || ""),
      indexHtml,
      stylesCss
    );
    if (grounded) return grounded;
  }

  function clip(label, s) {
    s = String(s || "");
    if (!s) return `${label}: (missing)`;
    if (s.length <= 9000) return `${label}:\n${s}`;
    return `${label} (clipped):\n---HEAD---\n${s.slice(
      0,
      4500
    )}\n---TAIL---\n${s.slice(-3500)}`;
  }

  // If files are missing or empty, we can still propose a diagnostic command.
  const fallbackDiag = {
    type: "run_cmd",
    title: "Capture UI file anchors for patching",
    reason:
      "Needed to generate an exact apply_patch that matches your current UI files.",
    payload: {
      cmd:
        `powershell.exe -NoProfile -Command "` +
        `$ErrorActionPreference='Continue'; ` +
        `Write-Host '=== index.html head ==='; ` +
        `Get-Content -Path '${path
          .join(ROOT, "public", "index.html")
          .replace(/\\/g, "\\\\")}' -TotalCount 80; ` +
        `Write-Host '=== index.html Recent Actions matches ==='; ` +
        `Select-String -Path '${path
          .join(ROOT, "public", "index.html")
          .replace(
            /\\/g,
            "\\\\"
          )}' -Pattern 'Recent Actions','history','actionsList','historyList' | ForEach-Object { $_.LineNumber.ToString()+': '+$_.Line }; ` +
        `Write-Host '=== styles.css head ==='; ` +
        `Get-Content -Path '${path
          .join(ROOT, "public", "styles.css")
          .replace(/\\/g, "\\\\")}' -TotalCount 120; ` +
        `Write-Host '=== styles.css layout matches ==='; ` +
        `Select-String -Path '${path
          .join(ROOT, "public", "styles.css")
          .replace(
            /\\/g,
            "\\\\"
          )}' -Pattern '#history','historyList','.panel','.wrap','.topbar','overflow','grid','flex' | ForEach-Object { $_.LineNumber.ToString()+': '+$_.Line }"`,
      timeoutMs: 12000,
    },
  };

  const sys =
    "You are Piper's upgrade planner.\n" +
    "The user is requesting a change/upgrade. You MUST propose approval-gated actions.\n" +
    "Output ONLY valid JSON with this exact schema:\n" +
    '{ "reply": "short", "proposed": [ { "type": "apply_patch|write_file|run_cmd|restart_piper|bundle|shutdown_piper", "title": "...", "reason": "...", "payload": { ... } } ] }\n' +
    "\n" +
    "Hard rules:\n" +
    "- proposed MUST contain at least ONE action. Never return an empty list.\n" +
    "- If the request is UI/layout: prefer apply_patch targeting public/index.html and/or public/styles.css.\n" +
    "- apply_patch payload schema:\n" +
    '  { "path":"public/index.html", "edits":[ { "find":"(exact substring from the file)", "replace":"...", "mode":"once|all" } ] }\n' +
    "- The find text MUST be copied EXACTLY from the provided file snippets (including spacing).\n" +
    "- If you cannot confidently craft an apply_patch that will match, propose ONE run_cmd diagnostic instead.\n" +
    "- Do not include markdown. JSON only.\n";

  const context = wantUi
    ? "Current files (use EXACT substrings from them for find/replace):\n\n" +
      clip("public/index.html", indexHtml) +
      "\n\n" +
      clip("public/styles.css", stylesCss)
    : "";

  const raw = await callOllama(
    [
      { role: "system", content: sys },
      { role: "user", content: `Request:\n${message}\n\n${context}` },
    ],
    { timeoutMs: 30000 }
  );

  let j = extractFirstJsonObject(raw);

  // Retry once if invalid OR empty proposed
  const bad =
    !j ||
    typeof j !== "object" ||
    typeof j.reply !== "string" ||
    !Array.isArray(j.proposed) ||
    j.proposed.length === 0;

  if (bad) {
    const retrySys =
      "Your output was invalid or had an empty proposed list.\n" +
      "You MUST return at least one action in proposed.\n" +
      "If you cannot craft a matching apply_patch, return a run_cmd diagnostic action.\n" +
      "Output ONLY valid JSON. No extra text.";
    const raw2 = await callOllama(
      [
        { role: "system", content: retrySys },
        { role: "user", content: `Request:\n${message}\n\n${context}` },
      ],
      { timeoutMs: 30000 }
    );
    j = extractFirstJsonObject(raw2);
  }

  // Final guard: if still empty, force our safe fallback diagnostic
  if (
    !j ||
    typeof j !== "object" ||
    typeof j.reply !== "string" ||
    !Array.isArray(j.proposed) ||
    j.proposed.length === 0
  ) {
    return {
      reply: enforceJarvis(
        "Understood. I’m queuing a quick diagnostic so I can generate an exact patch for approval."
      ),
      proposed: [fallbackDiag],
    };
  }

  return { reply: enforceJarvis(j.reply), proposed: j.proposed };
}

function normalizeProposedList(proposed) {
  const allowed = new Set([
    "apply_patch",
    "write_file",
    "run_cmd",
    "restart_piper",
    "bundle",
    "shutdown_piper",
  ]);
  const out = [];
  for (const p of proposed) {
    if (!p || typeof p !== "object") continue;
    const type = String(p.type || "");
    if (!allowed.has(type)) continue;

    out.push({
      type,
      title: String(p.title || type),
      reason: String(p.reason || ""),
      payload: p.payload && typeof p.payload === "object" ? p.payload : {},
    });
  }
  return out;
}

// -------------------- Patch / backup helpers --------------------
function safeResolve(relPath) {
  const p = String(relPath || "");
  if (!p) throw new Error("Missing path");
  const resolved = path.resolve(ROOT, p);
  const rootResolved = path.resolve(ROOT);
  if (!resolved.startsWith(rootResolved))
    throw new Error(`Path escapes root: ${p}`);
  return resolved;
}
function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
function actionBackupDir(actionId) {
  const d = path.join(ACTIONS_DIR, actionId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function makeBackup(actionId, targetPath) {
  const d = actionBackupDir(actionId);
  const base = path.basename(targetPath);
  const stamp = Date.now();
  const backupPath = path.join(d, `${base}.${stamp}.bak`);
  if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, backupPath);
  else fs.writeFileSync(backupPath, "", "utf8");
  return backupPath;
}
function restoreBackup(backupPath, targetPath) {
  if (!backupPath || !fs.existsSync(backupPath))
    throw new Error("Backup not found");
  ensureDirForFile(targetPath);
  fs.copyFileSync(backupPath, targetPath);
}
function applyPatchOnce(text, find, replace, mode = "once") {
  if (!find) return { out: text, changed: false };
  if (mode === "all") {
    const out = text.split(find).join(replace);
    return { out, changed: out !== text };
  }
  const idx = text.indexOf(find);
  if (idx === -1) return { out: text, changed: false };
  const out = text.slice(0, idx) + replace + text.slice(idx + find.length);
  return { out, changed: true };
}

// -------------------- Action executor --------------------
async function executeAction(action) {
  const startedAt = Date.now();
  const log = [];
  const push = (s) => log.push(`[${nowIso()}] ${s}`);

  const actionId = String(action.id || nowId());
  const type = String(action.type || "");
  const p = action.payload || {};

  try {
    if (type === "run_cmd") {
      const cmd = String(p.cmd || "");
      if (!cmd) throw new Error("run_cmd requires payload.cmd");

      // basic “don’t brick the box” guard
      const lower = cmd.toLowerCase();
      if (
        lower.includes("format ") ||
        lower.includes("del /f /s /q c:\\") ||
        lower.includes("rd /s /q c:\\")
      ) {
        throw new Error("run_cmd blocked: destructive command pattern.");
      }

      const timeoutMs = Number(p.timeoutMs || 25000);
      push(`run_cmd: ${cmd} (timeout ${timeoutMs}ms)`);

      const out = await new Promise((resolve, reject) => {
        exec(
          cmd,
          { timeout: timeoutMs, windowsHide: true },
          (err, stdout, stderr) => {
            if (err) return reject(new Error(String(err)));
            resolve({
              stdout: String(stdout || ""),
              stderr: String(stderr || ""),
            });
          }
        );
      });

      return { ok: true, tookMs: Date.now() - startedAt, log, result: out };
    }

    if (type === "restart_piper") {
      push("restart_piper requested (deferred until after approval response)");
      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: { restartRequested: true },
      };
    }

    if (type === "shutdown_piper") {
      push("shutdown_piper requested (deferred until after approval response)");
      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: { offRequested: true },
      };
    }

    if (type === "write_file") {
      const target = safeResolve(p.path);
      const content = String(p.content ?? "");
      ensureDirForFile(target);
      const backup = makeBackup(actionId, target);
      fs.writeFileSync(target, content, "utf8");
      push(`write_file: ${target}`);
      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: { path: target, backup },
      };
    }

    if (type === "apply_patch") {
      const target = safeResolve(p.path);
      const edits = Array.isArray(p.edits) ? p.edits : [];
      if (!edits.length)
        throw new Error("apply_patch requires payload.edits[]");

      const before = fs.existsSync(target)
        ? fs.readFileSync(target, "utf8")
        : "";
      let out = before;
      let changedAny = false;

      ensureDirForFile(target);
      const backup = makeBackup(actionId, target);

      for (const e of edits) {
        const find = String(e.find ?? "");
        const replace = String(e.replace ?? "");
        const mode = e.mode === "all" ? "all" : "once";
        const r = applyPatchOnce(out, find, replace, mode);
        out = r.out;
        if (r.changed) changedAny = true;
      }

      if (!changedAny) {
        throw new Error(
          "apply_patch: no edits matched the file (no changes applied)."
        );
      }

      fs.writeFileSync(target, out, "utf8");
      push(`apply_patch: ${target} changed=${changedAny}`);
      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: { path: target, backup, changed: changedAny },
      };
    }

    if (type === "bundle") {
      const list = Array.isArray(p.actions) ? p.actions : [];
      if (!list.length) throw new Error("bundle requires payload.actions[]");

      const results = [];
      let restartRequested = false;
      let offRequested = false;

      for (const sub of list) {
        const subAction = {
          id: actionId,
          type: String(sub.type || ""),
          payload: sub.payload || {},
        };
        const r = await executeAction(subAction);
        results.push({ type: subAction.type, ok: r.ok, result: r });
        if (subAction.type === "restart_piper" && r.ok) restartRequested = true;
        if (subAction.type === "shutdown_piper" && r.ok) offRequested = true;
        if (!r.ok) {
          return {
            ok: false,
            tookMs: Date.now() - startedAt,
            log,
            error: `bundle step failed: ${subAction.type}`,
            result: { results, restartRequested, offRequested },
          };
        }
      }

      return {
        ok: true,
        tookMs: Date.now() - startedAt,
        log,
        result: { results, restartRequested, offRequested },
      };
    }

    throw new Error(`Unknown action type: ${type}`);
  } catch (e) {
    push(`Error: ${String(e)}`);
    return { ok: false, tookMs: Date.now() - startedAt, log, error: String(e) };
  }
}

// -------------------- Routes --------------------
app.get("/ping", (req, res) =>
  res.json({ ok: true, port: PORT, pid: process.pid, time: nowIso() })
);

app.get("/actions", (req, res) => {
  loadActions();
  res.json({ ok: true, actions });
});

app.post("/action/reject", (req, res) => {
  const { id, note } = req.body || {};
  const a = actions.find((x) => x.id === id);
  if (!a)
    return res.status(404).json({ ok: false, error: "Unknown action id" });

  a.status = "rejected";
  a.updatedAt = Date.now();
  a.note = note ? String(note) : "";
  saveActions();
  res.json({ ok: true, action: a });
});

app.post("/action/rollback", (req, res) => {
  const { id } = req.body || {};
  const a = actions.find((x) => x.id === id);
  if (!a)
    return res.status(404).json({ ok: false, error: "Unknown action id" });

  try {
    const info = a.result?.result || {};
    const target = info.path;
    const backup = info.backup;
    if (!target || !backup)
      return res
        .status(400)
        .json({ ok: false, error: "No rollback info available." });

    restoreBackup(backup, target);
    a.status = "rolled_back";
    a.updatedAt = Date.now();
    a.rollback = { ok: true, restoredFrom: backup };
    saveActions();
    res.json({ ok: true, action: a });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/action/approve", async (req, res) => {
  const { id } = req.body || {};
  const a = actions.find((x) => x.id === id);
  if (!a)
    return res.status(404).json({ ok: false, error: "Unknown action id" });
  if (a.status !== "pending")
    return res.json({ ok: true, action: a, message: "Already processed" });

  a.status = "running";
  a.updatedAt = Date.now();
  saveActions();

  const result = await executeAction(a);
  a.result = result;
  a.updatedAt = Date.now();
  a.status = result.ok ? "done" : "failed";
  saveActions();

  // Respond FIRST so the UI doesn't show "Failed to fetch" on restarts
  res.json({ ok: true, action: a });

  const wantsRestart =
    (a.type === "restart_piper" && a.status === "done") ||
    (a.type === "bundle" &&
      a.status === "done" &&
      a.result?.result?.restartRequested);

  const wantsOff =
    (a.type === "shutdown_piper" && a.status === "done") ||
    (a.type === "bundle" &&
      a.status === "done" &&
      a.result?.result?.offRequested);

  if (wantsRestart) {
    setTimeout(() => {
      console.log("🔁 Approved restart — exiting with code 0...");
      process.exit(0);
    }, 250).unref();
    return;
  }

  if (wantsOff) {
    setTimeout(() => {
      console.log("🛑 Approved OFF — writing OFF.flag and exiting 99...");
      try {
        fs.writeFileSync(OFF_FLAG_PATH, `OFF ${nowIso()}\n`, "utf8");
      } catch {}
      process.exit(OFF_EXIT_CODE);
    }, 250).unref();
  }
});

// -------------------- Devices (agents) --------------------
app.post("/device/register", (req, res) => {
  const { deviceId, url, platform } = req.body || {};
  if (!deviceId || !url)
    return res
      .status(400)
      .json({ ok: false, error: "deviceId and url required" });
  const d = {
    deviceId: String(deviceId),
    url: String(url),
    platform: String(platform || ""),
    lastSeen: Date.now(),
  };
  devices.set(d.deviceId, d);
  res.json({ ok: true, device: d });
});
app.get("/devices", (req, res) => {
  res.json({
    ok: true,
    devices: Array.from(devices.values()).map((d) => ({
      ...d,
      lastSeenIso: new Date(d.lastSeen).toISOString(),
    })),
  });
});
app.post("/device/run", async (req, res) => {
  const { deviceId, action, app: appKey, args } = req.body || {};
  const d = devices.get(String(deviceId || ""));
  if (!d) return res.status(404).json({ ok: false, error: "Unknown deviceId" });

  try {
    d.lastSeen = Date.now();
    const r = await fetch(`${d.url}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, app: appKey, args: args || {} }),
    });
    const j = await r.json().catch(() => null);
    res.json({ ok: true, device: d.deviceId, result: j });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------------------- Voice: transcribe --------------------
app.post("/voice/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        error: "Missing audio file (field name must be 'audio')",
      });
    }
    if (!fs.existsSync(FFMPEG_EXE))
      return res
        .status(500)
        .json({ ok: false, error: `ffmpeg.exe not found: ${FFMPEG_EXE}` });
    if (!fs.existsSync(WHISPER_EXE))
      return res.status(500).json({
        ok: false,
        error: `whisper-cli.exe not found: ${WHISPER_EXE}`,
      });
    if (!fs.existsSync(WHISPER_MODEL))
      return res.status(500).json({
        ok: false,
        error: `whisper model not found: ${WHISPER_MODEL}`,
      });

    const ext = (req.file.originalname || "").split(".").pop() || "webm";
    const rawPath = path.join(TMP_DIR, `in_audio.${ext}`);
    const wav16k = path.join(TMP_DIR, "in_16k.wav");
    fs.writeFileSync(rawPath, req.file.buffer);

    const t0 = Date.now();
    const ffCmd = `"${FFMPEG_EXE}" -y -i "${rawPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wav16k}"`;

    exec(ffCmd, { windowsHide: true }, (ffErr, _ffOut, ffStderr) => {
      const convertMs = Date.now() - t0;
      if (ffErr) {
        console.error("[ffmpeg error]", ffErr);
        console.error("[ffmpeg stderr]", String(ffStderr || "").slice(-1500));
        return res
          .status(500)
          .json({ ok: false, error: "ffmpeg convert failed" });
      }

      const t1 = Date.now();
      const whisperCmd = `"${WHISPER_EXE}" -m "${WHISPER_MODEL}" -f "${wav16k}" -t ${WHISPER_THREADS} --no-timestamps`;

      exec(whisperCmd, { windowsHide: true }, (wErr, wOut, wStderr) => {
        const whisperMs = Date.now() - t1;
        if (wErr) {
          console.error("[whisper error]", wErr);
          console.error("[whisper stderr]", String(wStderr || "").slice(-1500));
          return res.status(500).json({ ok: false, error: "whisper failed" });
        }

        const text = String(wOut || "")
          .replace(/\r/g, "")
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .join(" ")
          .trim();

        return res.json({ ok: true, text, convertMs, whisperMs });
      });
    });
  } catch (e) {
    console.error("[voice/transcribe error]", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------------------- Voice: speak (robust + serialized) --------------------
let ttsQueue = Promise.resolve();

function runPiperToWav(text) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PIPER_EXE))
      return reject(new Error(`piper.exe not found: ${PIPER_EXE}`));
    if (!fs.existsSync(PIPER_VOICE))
      return reject(new Error(`piper voice not found: ${PIPER_VOICE}`));

    fs.writeFileSync(TMP_PIPER_TEXT, String(text || ""), "utf8");

    // Spawn piper.exe directly and feed stdin from the text file contents
    const child = spawn(
      PIPER_EXE,
      ["--model", PIPER_VOICE, "--output_file", TMP_PIPER_WAV],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] }
    );

    let errBuf = "";
    child.stderr.on("data", (d) => (errBuf += String(d)));

    try {
      const inText = fs.readFileSync(TMP_PIPER_TEXT, "utf8");
      child.stdin.write(inText);
      child.stdin.end();
    } catch (e) {
      try {
        child.kill();
      } catch {}
      return reject(e);
    }

    child.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(`piper.exe exit ${code}. ${errBuf}`));
      if (!fs.existsSync(TMP_PIPER_WAV))
        return reject(new Error("piper did not produce wav output"));
      resolve(TMP_PIPER_WAV);
    });
  });
}

function playWavSync(wavPath) {
  return new Promise((resolve, reject) => {
    // System.Media.SoundPlayer is simple + reliable
    const ps = `powershell.exe -NoProfile -WindowStyle Hidden -Command "$p='${wavPath.replace(
      /'/g,
      "''"
    )}'; $sp=New-Object System.Media.SoundPlayer $p; $sp.Load(); $sp.PlaySync();"`;
    exec(ps, { windowsHide: true }, (err, _out, stderr) => {
      if (err) return reject(new Error(String(stderr || err)));
      resolve(true);
    });
  });
}

app.post("/voice/speak", async (req, res) => {
  const raw = String(req.body?.text || "");
  const text = makeSpoken(raw);

  // respond immediately; do work in queue
  res.json({ ok: true });

  ttsQueue = ttsQueue
    .then(async () => {
      if (!text.trim()) return;
      try {
        const wav = await runPiperToWav(text);
        await playWavSync(wav);
      } catch (e) {
        console.error("[piper synth/play error]", e);
      }
    })
    .catch((e) => console.error("[tts queue error]", e));
});

// -------------------- Chat --------------------
app.post("/chat", async (req, res) => {
  const sessionId = String(req.body.sessionId || "default");
  const message = String(req.body.message || "");
  const readOnly = Boolean(req.body.readOnly); // ✅ the ONE safety toggle

  const s = sessions.get(sessionId) || { turns: 0 };
  const serious = isSerious(message);

  // 0) Read-only: never propose actions
  if (readOnly) {
    try {
      const sys = buildSystemPrompt({ turns: s.turns, serious });
      const out = await callOllama(
        [
          { role: "system", content: sys },
          { role: "user", content: message },
        ],
        { timeoutMs: 45000 }
      );
      s.turns += 1;
      sessions.set(sessionId, s);
      return res.json({ reply: enforceJarvis(out) });
    } catch (e) {
      console.error("[chat readOnly error]", e);
      s.turns += 1;
      sessions.set(sessionId, s);
      return res.json({ reply: "Something jammed. Try again." });
    }
  }

  // 1) App command fast-path
  const cmd = parseOpenCommand(message);
  if (cmd) {
    const apps = loadApps();
    const deviceId = pickDeviceIdFromTarget(cmd.target) || "pc";
    const appKey = resolveAppKey(cmd.appName, apps);

    let out;
    if (!appKey) out = `I can’t find "${cmd.appName}".`;
    else if (deviceId === "pc") out = openAppLocal(appKey, apps).message;
    else if (!devices.has(deviceId))
      out = `I can’t see your ${deviceId} connected.`;
    else {
      try {
        const r = await fetch(`http://localhost:${PORT}/device/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId,
            action: "open_app",
            app: appKey,
            args: {},
          }),
        });
        const j = await r.json();
        out =
          j.ok && j.result?.ok
            ? `Got it — opening ${appKey} on your ${deviceId}.`
            : `I tried, but your ${deviceId} agent refused.`;
      } catch {
        out = `I can’t reach your ${deviceId} right now.`;
      }
    }

    s.turns += 1;
    sessions.set(sessionId, s);
    return res.json({ reply: enforceJarvis(out) });
  }

  // 2) Deterministic: Restart/off requests ALWAYS become approval actions
  if (looksLikeRestartRequest(message)) {
    const a = addAction({
      id: nowId(),
      type: "restart_piper",
      title: "Restart Piper",
      reason: "User requested restart/reset.",
      payload: {},
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: null,
    });

    s.turns += 1;
    sessions.set(sessionId, s);
    return res.json({
      reply: enforceJarvis("Alright. I’ve queued a restart for your approval."),
      proposed: [{ id: a.id, type: a.type, title: a.title }],
    });
  }

  if (looksLikeOffRequest(message)) {
    const a = addAction({
      id: nowId(),
      type: "shutdown_piper",
      title: "Turn Piper Off",
      reason: "User requested shutdown/off.",
      payload: {},
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: null,
    });

    s.turns += 1;
    sessions.set(sessionId, s);
    return res.json({
      reply: enforceJarvis(
        "Understood. I’ve queued an OFF request for your approval."
      ),
      proposed: [{ id: a.id, type: a.type, title: a.title }],
    });
  }

  // 3) Option B: classifier decides if we should propose upgrades
  let intent = { mode: "chat", confidence: 0.5, reason: "" };
  try {
    intent = await classifyIntent(message);
  } catch (e) {
    console.error("[intent classify error]", e);
  }

  // Option B + hard triggers (single-line regex — JS safe)
  const hardUpgrade =
    /move|layout|ui|css|screen|panel|recent actions|history|sidebar|right side|left side|cut off|overflow|scroll|fix|bug|broken|update|change|improve|refactor|add|implement|integrate|discord|feature/i.test(
      message.toLowerCase()
    );

  const shouldPropose =
    hardUpgrade || (intent.mode === "propose" && intent.confidence >= 0.4);

  // Debug so you can see decisions in console
  console.log("[intent]", {
    msg: message.slice(0, 120),
    mode: intent.mode,
    confidence: intent.confidence,
    hardUpgrade,
    shouldPropose,
  });

  if (shouldPropose) {
    try {
      const plan1 = await proposeActions(message);
      console.log("[plan1.raw]", {
        reply: plan1?.reply,
        proposed: plan1?.proposed,
      });

      let proposed = normalizeProposedList(plan1.proposed);
      console.log("[plan1.norm]", {
        count: proposed.length,
        types: proposed.map((p) => p.type),
      });

      // If the planner returned nothing (or got filtered out), retry once with a stricter instruction.
      if (!proposed.length) {
        const retryMsg =
          message +
          "\n\nIMPORTANT: You MUST propose at least one approval-gated action.\n" +
          "If this is a UI/layout request, propose apply_patch to public/index.html and/or public/styles.css.\n" +
          "If you cannot find exact matching text, propose a diagnostic run_cmd that prints the public folder tree.";

        const plan2 = await proposeActions(retryMsg);
        console.log("[plan2.raw]", {
          reply: plan2?.reply,
          proposed: plan2?.proposed,
        });

        proposed = normalizeProposedList(plan2.proposed);
        console.log("[plan2.norm]", {
          count: proposed.length,
          types: proposed.map((p) => p.type),
        });
      }

      // Still nothing: tell the user clearly instead of silently "Understood".
      if (!proposed.length) {
        return res.json({
          reply: enforceJarvis(
            "I understand. I’m not generating an actionable patch yet — I likely can’t match the current file text. Try again, or ask: “Queue a patch to move Recent Actions to the right.”"
          ),
        });
      }

      // Queue actions
      const queued = [];
      for (const p of proposed) {
        const a = addAction({
          id: nowId(),
          type: p.type,
          title: p.title,
          reason:
            p.reason || intent.reason || "User requested an upgrade/change.",
          payload: p.payload || {},
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: null,
        });
        queued.push({ id: a.id, type: a.type, title: a.title });
      }

      return res.json({
        reply: enforceJarvis(plan1.reply || "Queued for approval."),
        proposed: queued,
      });
    } catch (e) {
      console.error("[propose error]", e);
      // If planner fails, fall through to normal chat below.
    }
  }

  // 4) Normal chat
  try {
    const sys = buildSystemPrompt({ turns: s.turns, serious });
    const out = await callOllama(
      [
        { role: "system", content: sys },
        { role: "user", content: message },
      ],
      { timeoutMs: 60000 }
    );
    s.turns += 1;
    sessions.set(sessionId, s);
    return res.json({ reply: enforceJarvis(out) });
  } catch (e) {
    console.error("[chat error]", e);
    s.turns += 1;
    sessions.set(sessionId, s);
    if (e?.code === "OLLAMA_TIMEOUT")
      return res.status(504).json({ ok: false, error: "chat timeout" });
    return res.status(500).json({ ok: false, error: "chat failed" });
  }
});

// -------------------- Shutdown --------------------
async function gracefulExit(code) {
  try {
    // close sockets for real port release
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {}
    }
    sockets.clear();

    if (server) {
      await new Promise((resolve) => server.close(() => resolve(true)));
    }
  } catch {}
  process.exit(code);
}

app.post("/shutdown", async (req, res) => {
  try {
    // OFF means supervisor should stop restarting
    fs.writeFileSync(OFF_FLAG_PATH, `OFF ${nowIso()}\n`, "utf8");
  } catch {}
  res.json({ ok: true, message: "Shutting down (OFF)..." });
  setTimeout(() => gracefulExit(OFF_EXIT_CODE), 150).unref();
});

// -------------------- Boot --------------------
server = app.listen(PORT, () => {
  console.log(`✅ Piper running: http://localhost:${PORT}`);
  // If OFF.flag exists, don't stay up (prevents “keeps coming back” if user wanted OFF)
  if (fs.existsSync(OFF_FLAG_PATH)) {
    console.log("🛑 OFF.flag present — exiting 99 so supervisor stops.");
    setTimeout(() => gracefulExit(OFF_EXIT_CODE), 200).unref();
  }
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

// Crash logging
process.on("uncaughtException", (err) =>
  console.error("🔥 uncaughtException:", err)
);
process.on("unhandledRejection", (err) =>
  console.error("🔥 unhandledRejection:", err)
);
