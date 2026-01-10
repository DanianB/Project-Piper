// src/routes/chat/deterministic/filesystem.js
import path from "path";

// Session-scoped "last opened folder" memory used by "in there".
const lastOpenedFolderBySid = new Map();

export function setLastOpenedFolder(sid, folderPath) {
  if (!sid) return;
  if (!folderPath) return;
  lastOpenedFolderBySid.set(String(sid), String(folderPath));
}

export function getLastOpenedFolder(sid) {
  return lastOpenedFolderBySid.get(String(sid)) || null;
}

export function parseOpenDesktopFolder(msg) {
  const raw = String(msg || "").trim();
  const t = raw.toLowerCase();

  // "open the folder on my desktop called worms"
  let m =
    t.match(
      /\bopen\s+(?:the\s+)?folder\s+on\s+my\s+desktop\s+(?:called|named)\s+["']?([^"']+?)["']?\b/i
    ) ||
    t.match(
      /\bopen\s+(?:the\s+)?folder\s+(?:called|named)\s+["']?([^"']+?)["']?\s+on\s+my\s+desktop\b/i
    );

  // "open the worms folder on my desktop"
  if (!m) m = t.match(/\bopen\s+(?:the\s+)?(.+?)\s+folder\s+on\s+my\s+desktop\b/i);

  if (!m) return null;

  const folderName = String(m[1] || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!folderName) return null;

  const base = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, "Desktop")
    : null;
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

export function parseWriteTextInThere(msg) {
  const raw = String(msg || "").trim();

  // phrases like:
  // "put a text document in there called 'Bone Worms' that tells me ..."
  const m = raw.match(
    /\b(?:put|create|make|write)\s+(?:a\s+)?(?:text\s+document|txt\s+file|text\s+file|document)\s+in\s+there\s+(?:called|named)\s+["']?([^"']+?)["']?\s+(?:that|which)\s+([\s\S]+)$/i
  );
  if (!m) return null;

  const name = String(m[1] || "").trim();
  const bodyRequest = String(m[2] || "").trim();
  if (!name) return null;

  const filename = name.toLowerCase().endsWith(".txt") ? name : `${name}.txt`;
  return { filename, bodyRequest };
}
