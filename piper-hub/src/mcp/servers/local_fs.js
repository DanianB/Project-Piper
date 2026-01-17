// src/mcp/servers/local_fs.js
// MCP stdio server exposing safe local filesystem read (and gated write).

import fs from "fs";
import path from "path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

function clampInt(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(x)));
}

function userProfile() {
  return (
    process.env.USERPROFILE ||
    (process.env.HOMEDRIVE && process.env.HOMEPATH
      ? process.env.HOMEDRIVE + process.env.HOMEPATH
      : null) ||
    process.env.HOME ||
    ""
  );
}

function mapKnownPath(p) {
  const raw = String(p || "").trim();
  if (!raw) return raw;

  // Accept: known:desktop/..., known:downloads/..., known:documents/...
  const m = raw.match(/^known:(desktop|downloads|documents)(?:\/(.*))?$/i);
  if (!m) return raw;

  const which = m[1].toLowerCase();
  const tail = m[2] ? String(m[2]) : "";
  const base = userProfile();
  if (!base) return raw;

  const folderName =
    which === "desktop"
      ? "Desktop"
      : which === "downloads"
      ? "Downloads"
      : "Documents";

  return path.join(base, folderName, tail);
}

function safeResolveAbsolute(p) {
  const mapped = mapKnownPath(p);
  const abs = path.resolve(mapped);

  // allow within user profile or within repo
  const home = userProfile();
  const repo = process.cwd();

  const okHome = home && abs.toLowerCase().startsWith(path.resolve(home).toLowerCase());
  const okRepo = abs.toLowerCase().startsWith(path.resolve(repo).toLowerCase());

  if (!okHome && !okRepo) {
    throw new Error(
      "Path not allowed. Only paths inside your user profile or the Piper repo are permitted."
    );
  }

  return abs;
}

function listDir(absPath, maxEntries = 200) {
  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  const out = [];
  for (const e of entries.slice(0, maxEntries)) {
    out.push({
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
    });
  }
  return out;
}

const server = new Server(
  { name: "piper-local-fs", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "fs_list_dir",
        description:
          "List directory entries. Read-only. Supports known:desktop|downloads|documents paths.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            maxEntries: { type: "number", default: 200 },
          },
          required: ["path"],
        },
        annotations: { risk: "read_only" },
      },
      {
        name: "fs_read_file",
        description:
          "Read a text file (best-effort UTF-8). Read-only. Supports known:* paths.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            maxChars: { type: "number", default: 40000 },
          },
          required: ["path"],
        },
        annotations: { risk: "read_only" },
      },
      {
        name: "fs_write_file",
        description:
          "Write a text file (UTF-8). SIDE EFFECT: should be approval-gated by the client.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            overwrite: { type: "boolean", default: false },
          },
          required: ["path", "content"],
        },
        annotations: { risk: "external_side_effect" },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req?.params?.name || "");
  const args = req?.params?.arguments || {};

  if (name === "fs_list_dir") {
    const p = safeResolveAbsolute(args?.path);
    const maxEntries = clampInt(args?.maxEntries, 1, 2000, 200);
    const out = { path: p, entries: listDir(p, maxEntries) };
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
      structuredContent: out,
    };
  }

  if (name === "fs_read_file") {
    const p = safeResolveAbsolute(args?.path);
    const maxChars = clampInt(args?.maxChars, 1000, 200000, 40000);
    const raw = fs.readFileSync(p, "utf8");
    const text = raw.length > maxChars ? raw.slice(0, maxChars) + `...(+${raw.length - maxChars} chars)` : raw;
    const out = { path: p, text };
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
      structuredContent: out,
    };
  }

  if (name === "fs_write_file") {
    // The client should gate this via approval; server still supports it.
    const p = safeResolveAbsolute(args?.path);
    const overwrite = Boolean(args?.overwrite);
    if (!overwrite && fs.existsSync(p)) throw new Error("File exists (overwrite=false)");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(args?.content ?? ""), "utf8");
    const out = { path: p, ok: true };
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
      structuredContent: out,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
