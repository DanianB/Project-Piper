// src/services/plan/store.js
import fs from "fs";
import path from "path";
import { normalizePlanDraft, validatePlan } from "./schema.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const PLANS_PATH = path.join(DATA_DIR, "plans.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  ensureDataDir();
  if (!fs.existsSync(PLANS_PATH)) return { bySid: {} };
  try {
    return JSON.parse(fs.readFileSync(PLANS_PATH, "utf-8"));
  } catch {
    return { bySid: {} };
  }
}

function writeAll(obj) {
  ensureDataDir();
  fs.writeFileSync(PLANS_PATH, JSON.stringify(obj, null, 2), "utf-8");
}

export function getCurrentPlan(sid) {
  if (!sid) return null;
  const all = readAll();
  return all.bySid?.[sid]?.current || null;
}

export function upsertPlan(draft) {
  const plan = normalizePlanDraft(draft);
  const v = validatePlan(plan);
  if (!v.ok) throw new Error(v.error);

  const all = readAll();
  all.bySid = all.bySid || {};
  all.bySid[plan.sid] = all.bySid[plan.sid] || { current: null, history: [] };

  // push old current into history
  if (all.bySid[plan.sid].current) all.bySid[plan.sid].history.unshift(all.bySid[plan.sid].current);

  all.bySid[plan.sid].current = plan;
  writeAll(all);
  return plan;
}

export function setPlanStatus(sid, status) {
  const all = readAll();
  const cur = all.bySid?.[sid]?.current;
  if (!cur) return null;
  cur.status = status;
  cur.updatedAt = new Date().toISOString();
  all.bySid[sid].current = cur;
  writeAll(all);
  return cur;
}
