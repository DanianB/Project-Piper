// src/routes/chat/index.js
import { Router } from "express";
import { chatHandler } from "./handler.js";

// Chat route package entrypoint.
// This is the modular, non-legacy chat route.
export function chatRoutes() {
  const r = Router();
  r.post("/chat", chatHandler);
  return r;
}

export default chatRoutes;
