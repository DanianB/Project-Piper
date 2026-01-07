// src/tools/builtins/repo.js
import fs from "fs";
import path from "path";
import { ROOT } from "../../config/paths.js";
import { toolRegistry, ToolRisk } from "../registry.js";

function isSubPath(p) {
  const abs = path.resolve(ROOT, p);
  return abs.startsWith(ROOT);
}

function isSkippedDir(name) {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === "dist" ||
    name === "build" ||
    name === "tmp" ||
    name === "data" ||
    name === ".next" ||
    name === ".cache"
  );
}

function allowedExt(file) {
  const ext = path.extname(file).toLowerCase();
  return [
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".json",
    ".html",
    ".css",
    ".md",
    ".txt",
  ].includes(ext);
}

function* walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (isSkippedDir(ent.name)) continue;
      yield* walkFiles(p);
    } else if (ent.isFile()) {
      if (!allowedExt(p)) continue;
      yield p;
    }
  }
}

function clampInt(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(x)));
}

toolRegistry.register({
  id: "repo.openFile",
  description: "Read a file from the Piper repo (line-ranged). Returns text and basic metadata.",
  risk: ToolRisk.READ_ONLY,
  validateArgs: (args) => {
    if (!args || typeof args !== "object") return { ok: false, error: "args must be object" };
    if (!args.path || typeof args.path !== "string") return { ok: false, error: "path (string) required" };
    return { ok: true };
  },
  handler: async ({ args }) => {
    const rel = args.path.replace(/^[\\/]+/, "");
    if (!isSubPath(rel)) throw new Error("Path must be within repo");
    const abs = path.resolve(ROOT, rel);
    const stat = fs.statSync(abs);

    const maxBytes = 512 * 1024;
    if (stat.size > maxBytes) {
      throw new Error(`File too large (> ${maxBytes} bytes)`);
    }

    const content = fs.readFileSync(abs, "utf-8");
    const lines = content.split(/\r?\n/);

    const start = clampInt(args.startLine ?? 1, 1, lines.length, 1);
    const end = clampInt(args.endLine ?? Math.min(lines.length, start + 200), start, lines.length, Math.min(lines.length, start + 200));

    const slice = lines.slice(start - 1, end).join("\n");
    return {
      path: rel,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      text: slice,
    };
  },
});

toolRegistry.register({
  id: "repo.searchText",
  description: "Search text across repo files (fast substring match). Returns top matches with line previews.",
  risk: ToolRisk.READ_ONLY,
  validateArgs: (args) => {
    if (!args || typeof args !== "object") return { ok: false, error: "args must be object" };
    if (!args.query || typeof args.query !== "string" || !args.query.trim()) {
      return { ok: false, error: "query (non-empty string) required" };
    }
    return { ok: true };
  },
  handler: async ({ args }) => {
    const query = String(args.query || "").trim();
    const maxResults = clampInt(args.maxResults ?? 30, 1, 200, 30);
    const caseSensitive = Boolean(args.caseSensitive);
    const q = caseSensitive ? query : query.toLowerCase();

    const results = [];
    const maxBytes = 512 * 1024;

    for (const fileAbs of walkFiles(ROOT)) {
      if (results.length >= maxResults) break;

      let stat;
      try {
        stat = fs.statSync(fileAbs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > maxBytes) continue;

      let content;
      try {
        content = fs.readFileSync(fileAbs, "utf-8");
      } catch {
        continue;
      }

      const hay = caseSensitive ? content : content.toLowerCase();
      if (!hay.includes(q)) continue;

      const rel = path.relative(ROOT, fileAbs).replace(/\\/g, "/");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineHay = caseSensitive ? line : line.toLowerCase();
        const at = lineHay.indexOf(q);
        if (at === -1) continue;

        results.push({
          path: rel,
          line: i + 1,
          col: at + 1,
          preview: line.slice(0, 300),
        });

        if (results.length >= maxResults) break;
      }
    }

    return {
      query,
      maxResults,
      matches: results,
      note:
        results.length === 0
          ? "No matches found."
          : "Use repo.openFile on a match path+line range to inspect more context.",
    };
  },
});

export function registerRepoTools() {
  // no-op: importing this module registers the tools
  return true;
}
