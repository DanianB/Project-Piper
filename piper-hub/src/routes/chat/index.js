// src/routes/chat/index.js
import { Router } from "express";
import { chatHandler } from "./handler.js";

export function chatRoutes() {
  const r = Router();
  r.post("/chat", chatHandler);
  return r;
}

export default chatRoutes;
