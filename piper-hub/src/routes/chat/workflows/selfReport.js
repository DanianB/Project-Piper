// src/routes/chat/workflows/selfReport.js
function maybeAddExplicitSelfReport(text, emotion, intensity) {
  if (intensity < 0.78) return text;
  if (!shouldSelfReportExplicitly()) return text;

  const e = String(emotion || "neutral");
  let line = null;

  if (e === "angry")
    line =
      "I’m getting a bit impatient, sir — this should have behaved by now.";
  else if (e === "concerned")
    line =
      "I’m slightly concerned, sir — let’s keep it controlled and inspect first.";
  else if (e === "sad")
    line = "That’s… unfortunate. Let’s see what we can salvage.";
  else if (e === "excited")
    line = "I’m genuinely pleased with that result, sir.";
  else if (e === "confident") line = "I’m satisfied with this direction, sir.";

  if (!line) return text;

  markSelfReportUsed();
  return `${line}\n\n${text}`;
}

export { maybeAddExplicitSelfReport };
