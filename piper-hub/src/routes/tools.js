// src/routes/tools.js
import { Router } from "express";
import { listTools } from "../tools/index.js";

export function toolsRoutes() {
  const r = Router();

  // List available tools (debug)
  r.get("/tools", (req, res) => {
    res.json({ tools: listTools() });
  });

  return r;
}
