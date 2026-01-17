// src/mcp/servers/local_web.js
// MCP stdio server exposing web search/fetch as MCP tools.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { toolRegistry } from "../../tools/registry.js";
import "../../tools/builtins/web.js";

function clampInt(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(x)));
}

const server = new Server(
  { name: "piper-local-web", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "web_search",
        description:
          "Web search (maps to Piper web.search). Read-only. Returns {query,engine,results}.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            maxResults: { type: "number", default: 5 },
          },
          required: ["query"],
        },
        annotations: { risk: "read_only" },
      },
      {
        name: "web_fetch",
        description:
          "Fetch a URL (maps to Piper web.fetch). Read-only. Returns {url,status,ok,contentType,text}.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            maxChars: { type: "number", default: 20000 },
          },
          required: ["url"],
        },
        annotations: { risk: "read_only" },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req?.params?.name || "");
  const args = req?.params?.arguments || {};

  if (name === "web_search") {
    const query = String(args?.query || "").trim();
    const maxResults = clampInt(args?.maxResults, 1, 25, 5);
    const ran = await toolRegistry.run({
      id: "web.search",
      args: { query, maxResults: Math.min(maxResults, 10) },
      context: {},
    });
    if (!ran.ok) throw new Error(ran.error || "web.search failed");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(ran.result),
        },
      ],
      structuredContent: ran.result,
    };
  }

  if (name === "web_fetch") {
    const url = String(args?.url || "").trim();
    const maxChars = clampInt(args?.maxChars, 2000, 80000, 20000);
    const ran = await toolRegistry.run({
      id: "web.fetch",
      args: { url, maxChars },
      context: {},
    });
    if (!ran.ok) throw new Error(ran.error || "web.fetch failed");

    return {
      content: [{ type: "text", text: JSON.stringify(ran.result) }],
      structuredContent: ran.result,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
