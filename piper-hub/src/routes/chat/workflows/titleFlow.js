// src/routes/chat/workflows/titleFlow.js
function handleTitleRequest(msg) {
  const m = String(msg || "").match(
    /(?:set|change)\s+(?:the\s+)?title\s+to\s+"([^"]+)"/i
  );
  const desired = String(m?.[1] || "").trim();
  if (!desired) return null;

  const id = newId();
  addAction({
    id,
    type: "set_html_title",
    title: `Set page title to "${desired}"`,
    reason: "Deterministic edit: set the <title> tag in public/index.html.",
    payload: { path: "public/index.html", title: desired },
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  logMode(sid ?? "no_sid", "approval_action", { kind: "set_html_title" });
  return {
    reply: enforcePiper(
      `Queued for approval, sir. I will set the page title to "${desired}".`
    ),
    proposed: [
      { id, type: "set_html_title", title: `Set page title to "${desired}"` },
    ],
  };
}

export { handleTitleRequest };
