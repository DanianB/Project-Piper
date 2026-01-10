// src/routes/chat/policies/actions.js
function shouldAllowActions(reqBody) {
  const userInitiated = reqBody?.userInitiated === true;
  const readOnly = Boolean(reqBody?.readOnly);
  return userInitiated && !readOnly;
}

function reqMeta(req) {
  const ua = String(req?.headers?.["user-agent"] || "");
  const ip = String(
    req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || ""
  );
  return { ua, ip };
}

export { shouldAllowActions, reqMeta };
