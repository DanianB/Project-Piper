// src/routes/chat/workflows/pendingActions.js
import { addAction } from "../../../actions/store.js";
import { newId } from "../utils/ids.js";

function addPendingAction(partial) {
  const now = Date.now();
  const id = newId();
  const full = {
    id,
    type: partial?.type,
    title: partial?.title,
    reason: partial?.reason,
    payload: partial?.payload || {},
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  return addAction(full);
}

export { addPendingAction };
