// src/routes/chat/utils/ids.js
function newId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

export { newId };
