// src/routes/chat/deterministic/greetings.js

/**
 * Deterministic greeting detection + Jarvis-style responses.
 * No tools. No planner. No approvals.
 */

export function isGreeting(input) {
  const t = String(input || "").trim();
  if (!t) return false;

  return /^(hi|hey|hello|yo|g'day|good (morning|afternoon|evening))\b/i.test(t);
}

export function greetingReply(input) {
  const raw = String(input || "").trim();
  const lower = raw.toLowerCase();

  // Slightly special-cased for addressing Piper directly
  if (/hello piper\b/i.test(lower)) {
    return "At your service, sir.";
  }

  if (lower === "hi" || lower === "hey") {
    return "Hello, sir.";
  }

  if (lower.startsWith("good morning")) {
    return "Good morning, sir.";
  }

  if (lower.startsWith("good afternoon")) {
    return "Good afternoon, sir.";
  }

  if (lower.startsWith("good evening")) {
    return "Good evening, sir.";
  }

  // Default: short, confident, Jarvis-like
  return "Online. How can I help, sir?";
}
