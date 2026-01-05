import fs from "fs";
import path from "path";
import os from "os";
import { ROOT } from "../config/paths.js";

/**
 * Resolve:
 *  - normal repo-relative paths (must remain inside ROOT)
 *  - special "known:" paths like "known:downloads/foo"
 *
 * This is what makes actions like mkdir/write_file into Downloads possible.
 */
export function safeResolve(relPath) {
  const p = String(relPath || "").trim();
  if (!p) throw new Error("Missing path");

  // Support known: downloads / desktop / documents
  if (p.startsWith("known:")) {
    const rest = p.slice("known:".length); // e.g. "downloads/piper-tests"
    const parts = rest.split("/").filter(Boolean);
    const which = String(parts.shift() || "").toLowerCase();
    const tail = parts.join(path.sep);

    // Windows-friendly user home
    const home = process.env.USERPROFILE || os.homedir();

    // Basic known folder map
    const baseMap = {
      downloads: path.join(home, "Downloads"),
      desktop: path.join(home, "Desktop"),
      documents: path.join(home, "Documents"),
    };

    const base = baseMap[which];
    if (!base) {
      throw new Error(
        `Unknown known: location "${which}". Supported: downloads, desktop, documents`
      );
    }

    const resolved = path.resolve(base, tail || ".");
    const baseResolved = path.resolve(base);

    // Ensure it stays inside that known folder
    if (!resolved.startsWith(baseResolved)) {
      throw new Error(`Path escapes known:${which}: ${p}`);
    }

    return resolved;
  }

  // Default: must stay inside repo ROOT
  const resolved = path.resolve(ROOT, p);
  const rootResolved = path.resolve(ROOT);

  if (!resolved.startsWith(rootResolved)) {
    throw new Error(`Path escapes root: ${p}`);
  }

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
