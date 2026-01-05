import fs from "fs";
import path from "path";
import { ROOT } from "../config/paths.js";

export function safeResolve(relPath) {
  const p = String(relPath || "");
  if (!p) throw new Error("Missing path");
  const resolved = path.resolve(ROOT, p);
  const rootResolved = path.resolve(ROOT);
  if (!resolved.startsWith(rootResolved))
    throw new Error(`Path escapes root: ${p}`);
  return resolved;
}

export function ensureDirForFile(absPath) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
}

export function readTextIfExists(absPath, fallback = "") {
  try {
    return fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : fallback;
  } catch {
    return fallback;
  }
}
