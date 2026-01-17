// src/routes/chat/parsers/filesystem.js
import path from "path";
import os from "os";

// sid -> last opened folder path (for "in there")
const _lastOpened = new Map();

export function getLastOpenedFolder(sid) {
  return _lastOpened.get(String(sid || "")) || null;
}

export function setLastOpenedFolder(sid, folderPath) {
  if (!sid) return;
  _lastOpened.set(String(sid), String(folderPath || ""));
}

function desktopRoot() {
  return path.join(os.homedir(), "Desktop");
}

function hasDesktopPhrase(s) {
  return (
    /\b(on|in)\s+(my|your|the)?\s*desktop\b/i.test(s) ||
    /\bdesktop\b/i.test(s)
  );
}

function extractQuoted(s) {
  const m = String(s || "").match(/["']([^"']+)["']/);
  return m ? m[1].trim() : null;
}

function stripArticle(name) {
  return String(name || "")
    .trim()
    .replace(/^(the|a|an)\s+/i, "")
    .trim();
}

function cleanPunct(name) {
  return String(name || "")
    .trim()
    .replace(/[.?!,;:]+$/g, "")
    .trim();
}

function extractFolderName(s) {
  const q = extractQuoted(s);
  if (q) return q;

  // "open worms folder ..."
  const m = s.match(/\bopen\b\s+(.+?)\s+\bfolder\b/i);
  if (m && m[1]) return m[1].trim();

  // "open the worms on my desktop" (no word 'folder')
  const m2 = s.match(/\bopen\b\s+(?:the\s+)?(.+?)\s+\b(on|in)\b\s+(my|your|the)?\s*desktop\b/i);
  if (m2 && m2[1]) return m2[1].trim();

  return null;
}

/**
 * Deterministic: open a folder on the Desktop.
 * Returns a structured object used by handler.js.
 */
export function parseOpenDesktopFolder(msg) {
  const s = String(msg || "").trim();
  if (!s) return null;
  if (!/\b(open|show|launch|go to)\b/i.test(s)) return null;
  if (!hasDesktopPhrase(s)) return null;

  let folderName = extractFolderName(s);
  if (!folderName) return null;
  folderName = stripArticle(cleanPunct(folderName));
  if (!folderName) return null;

  const folderPath = path.join(desktopRoot(), folderName);

  return {
    type: "open_path",
    title: `Open folder: ${folderName}`,
    reason: `User asked to open the "${folderName}" folder on the Desktop.`,
    payload: { path: folderPath, kind: "folder" },
    _folderName: folderName,
    _folderPath: folderPath,
  };
}

function ensureTxt(name) {
  const base = String(name || "").trim();
  if (!base) return "";
  return /\.[a-z0-9]+$/i.test(base) ? base : `${base}.txt`;
}

/**
 * Deterministic: "put a txt/text file in there called X [with ...]"
 * Returns the intended filename plus the user's request body (optional) so the
 * handler may optionally generate content.
 */
export function parseWriteTextInThere(msg) {
  const s = String(msg || "").trim();
  if (!s) return null;

  // Must refer to "in there" (uses last opened folder)
  if (!/\b(in there|in that folder|in this folder|there)\b/i.test(s)) return null;
  if (!/\b(put|create|make|write|add)\b/i.test(s)) return null;
  if (!/\b(text|txt)\s+file\b/i.test(s) && !/\btext\s+document\b/i.test(s) && !/\bfile\b/i.test(s)) return null;

  // filename (prefer quoted)
  let base =
    extractQuoted(s) ||
    (s.match(/\bcalled\s+(.+?)(?:\bwith\b|\bcontaining\b|$)/i)?.[1] || "").trim() ||
    (s.match(/\bnamed\s+(.+?)(?:\bwith\b|\bcontaining\b|$)/i)?.[1] || "").trim();

  base = stripArticle(cleanPunct(base));
  if (!base) return null;

  const filename = ensureTxt(base);

  // optional body request (not the actual file content)
  const bodyRequest = (s.match(/\b(with|containing)\s+([\s\S]+)$/i)?.[2] || "").trim();

  return {
    filename,
    bodyRequest: bodyRequest || "(no additional content specified)",
  };
}
