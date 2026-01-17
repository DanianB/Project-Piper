// src/routes/chat/parsers/apps.js
import fs from "fs";
import path from "path";

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

/**
 * Return the allowlisted target for an appId (usually a .exe path, shortcut, or command).
 * apps.json is expected to be an object map: { "spotify": "%APPDATA%\\Spotify\\Spotify.exe", ... }
 */
function getAllowlistedAppTarget(appId) {
  const apps = readAppsAllowlist();
  if (!appId) return null;
  const key = String(appId).trim();
  if (!key) return null;
  const v = apps && Object.prototype.hasOwnProperty.call(apps, key) ? apps[key] : null;
  return v != null ? String(v) : null;
}

export {
  readAppsAllowlist,
  listAllowlistedAppIds,
  isListAppsIntent,
  parseOpenAllowlistedApp,
  getAllowlistedAppTarget,
};
