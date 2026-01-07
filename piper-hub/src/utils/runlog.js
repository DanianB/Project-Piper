// src/utils/runlog.js
import fs from "fs";
import { RUNLOG_FILE } from "../config/paths.js";

/**
 * Append a structured event to runlog (JSONL).
 * Keep payload small; redact secrets before calling.
 */
export function logRunEvent(event) {
  try {
    const e = {
      ts: Date.now(),
      ...event,
    };
    fs.appendFileSync(RUNLOG_FILE, JSON.stringify(e) + "\n", "utf8");
  } catch (err) {
    // Non-fatal: never crash Piper due to logging
    console.warn("[runlog] failed:", err?.message || err);
  }
}

export function readRunLog(limit = 200) {
  try {
    const raw = fs.readFileSync(RUNLOG_FILE, "utf8");
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-Math.max(1, Math.min(2000, limit)));
    return slice
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean)
      .reverse(); // newest first
  } catch (err) {
    return [];
  }
}
