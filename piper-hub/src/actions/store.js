import fs from "fs";
import { ACTIONS_FILE } from "../config/paths.js";

let actions = [];

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function loadActions() {
  try {
    if (!fs.existsSync(ACTIONS_FILE)) {
      actions = [];
      return actions;
    }

    const raw = fs.readFileSync(ACTIONS_FILE, "utf8");
    const parsed = safeParseJson(raw);
    actions = Array.isArray(parsed) ? parsed : [];
    // Sanitize: drop null/invalid entries that can break the UI
    actions = (actions || []).filter((a) => a && typeof a === "object" && typeof a.id === "string");
    // Normalize missing fields
    actions = actions.map((a) => ({
      status: a.status || "pending",
      createdAt: a.createdAt || Date.now(),
      updatedAt: a.updatedAt || a.createdAt || Date.now(),
      result: a.result ?? null,
      ...a,
    }));
  } catch {
    actions = [];
  }

  // Always keep newest-first in memory.
  // (If old data was oldest-first, this normalizes it.)
  actions.sort((a, b) => {
    const ta = Number(a?.updatedAt || a?.createdAt || 0);
    const tb = Number(b?.updatedAt || b?.createdAt || 0);
    return tb - ta;
  });

  return actions;
}

export function saveActions() {
  fs.writeFileSync(ACTIONS_FILE, JSON.stringify(actions, null, 2), "utf8");
}

export function listActions() {
  loadActions();
  return actions;
}

export function addAction(action) {
  loadActions();

  // Put newest actions at the FRONT so any UI slice(0, 10) shows newest.
  actions.unshift(action);

  // Cap to prevent unbounded growth (adjust if you want)
  const MAX = 200;
  if (actions.length > MAX) actions = actions.slice(0, MAX);

  saveActions();
  return action;
}

export function updateAction(id, patch) {
  loadActions();

  const idx = actions.findIndex((x) => x.id === id);
  if (idx === -1) return null;

  const prev = actions[idx];
  const next = Object.assign({}, prev, patch);

  actions[idx] = next;

  // Re-sort newest-first after updates (since updatedAt changes)
  actions.sort((a, b) => {
    const ta = Number(a?.updatedAt || a?.createdAt || 0);
    const tb = Number(b?.updatedAt || b?.createdAt || 0);
    return tb - ta;
  });

  saveActions();
  return next;
}

export function getActionById(id) {
  loadActions();
  return actions.find((x) => x.id === id) || null;
}