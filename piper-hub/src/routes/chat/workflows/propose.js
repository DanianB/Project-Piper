// src/routes/chat/workflows/propose.js
import crypto from "crypto";
import { addAction as addQueuedAction } from "../../../actions/store.js";

function makeId() {
  return (
    "act_" + crypto.randomBytes(8).toString("hex") + Date.now().toString(16)
  );
}

/**
 * Turn an intended side-effect into an approval item that the UI can approve/reject.
 * Returns the queued action object (what should go in `proposed`).
 */
export function proposeAction({ type, title, reason, payload }) {
  const action = {
    id: makeId(),
    type: String(type || ""),
    title: String(title || type || "Action"),
    reason: String(reason || ""),
    payload: payload && typeof payload === "object" ? payload : {},
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
  };

  addQueuedAction(action);
  return action;
}
