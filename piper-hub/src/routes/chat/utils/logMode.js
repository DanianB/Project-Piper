// src/routes/chat/utils/logMode.js
function logMode(sid, mode, extra = {}) {
  try {
    console.log("[mode]", { sid, mode, ...extra });
  } catch {}
}

export { logMode };
