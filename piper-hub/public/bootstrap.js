// bootstrap.js — shared globals for Piper UI
// Generated split from original index.html script.

(function(){
  const sid = localStorage.getItem('piper_sessionId') || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  localStorage.setItem('piper_sessionId', sid);
  window.sessionId = sid;
})();
