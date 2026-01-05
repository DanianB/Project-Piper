// src/planner/snapshot.js
import path from "path";
import { ROOT } from "../config/paths.js";
import { LIMITS, ALLOWLIST_SNAPSHOT_FILES } from "../config/constants.js";
import { readTextIfExists } from "../utils/fsx.js";
import { parseButtonsFromHtml, parseCssBlocks } from "./uimapper.js";
import { buildFileBlocks } from "./chunker.js";
import { listActions } from "../actions/store.js";

function clip(s, max) {
  s = String(s || "");
  if (s.length <= max) return s;
  return (
    s.slice(0, max) +
    "\n/* ...clipped... */\n" +
    s.slice(-Math.floor(max * 0.2))
  );
}

export function buildSnapshot() {
  const files = {};
  const rawFiles = {};
  const blocks = [];

  const allow = ALLOWLIST_SNAPSHOT_FILES.slice(0, LIMITS.snapshotMaxFiles);
  for (const rel of allow) {
    const abs = path.join(ROOT, rel);
    const raw = readTextIfExists(abs, "");
    rawFiles[rel] = raw;
    files[rel] = clip(raw, LIMITS.snapshotMaxCharsPerFile);

    // Build block map from the FULL raw text (not clipped)
    try {
      const b = buildFileBlocks(rel, raw);
      blocks.push(...b);
    } catch {}
  }

  const indexHtml = rawFiles["public/index.html"] || "";
  const stylesCss = rawFiles["public/styles.css"] || "";

  const uiMap = {
    buttons: parseButtonsFromHtml(indexHtml),
    cssBlocks: parseCssBlocks(stylesCss),
  };

  const capabilities = {
    canProposeActions: true,
    actions: [
      "apply_patch",
      "write_file",
      "run_cmd",
      "bundle",
      "restart_piper",
      "shutdown_piper",
      "read_snippet",
    ],
    preview: true,
    devices: true,
    apps: true,
    voice: true,

    // grounded edits
    editFileByBlockId: true,
  };

  // Include recent read_snippet outputs so the planner can ground edits.
  // Only include non-pending successful reads, and clip snippet size.
  const readSnippets = listActions()
    .filter((a) => a && a.type === "read_snippet")
    .filter((a) => a.status && a.status !== "pending")
    .filter(
      (a) =>
        a.result && a.result.ok && a.result.result && a.result.result.snippet
    )
    .sort(
      (a, b) =>
        Number(b.updatedAt || b.createdAt || 0) -
        Number(a.updatedAt || a.createdAt || 0)
    )
    .slice(0, 6)
    .map((a) => {
      const r = a.result.result;
      const snippet = clip(String(r.snippet || ""), 9000);
      return {
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        totalLines: r.totalLines,
        truncated: Boolean(r.truncated),
        snippet,
      };
    });

  return { files, rawFiles, blocks, uiMap, capabilities, readSnippets };
}
