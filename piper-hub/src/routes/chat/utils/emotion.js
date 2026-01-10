// src/routes/chat/utils/emotion.js
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.4;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pickEmotion({
  msg,
  affect,
  opinionScore,
  disagreeLevel,
  authorityOverride,
}) {
  const m = String(msg || "").toLowerCase();
  const fr = affect?.frustration?.total || 0;
  const streaks = affect?.frustration?.streaks || {};
  const mood = Number(affect?.mood || 0);

  // Priority: user forcing an override after disagreement
  if (authorityOverride && disagreeLevel > 0) {
    return { emotion: "serious", intensity: 0.65 };
  }

  // Repeated failures / high friction
  if (fr >= 2.2 || (streaks.llmFail || 0) >= 2 || (streaks.ttsFail || 0) >= 2) {
    // Keep within the supported emotion set.
    return {
      emotion: "angry",
      intensity: clamp01(0.65 + 0.12 * Math.min(1, fr / 3)),
    };
  }

  // If user is reporting problems
  if (
    m.includes("not working") ||
    m.includes("error") ||
    m.includes("slow") ||
    m.includes("stuck")
  ) {
    return { emotion: "concerned", intensity: 0.55 };
  }

  // Opinion queries
  if (typeof opinionScore === "number") {
    if (opinionScore > 0.25) return { emotion: "amused", intensity: 0.45 };
    if (opinionScore < -0.25) return { emotion: "dry", intensity: 0.5 };
    return { emotion: "neutral", intensity: 0.4 };
  }

  // Mood influence
  if (mood > 0.35) return { emotion: "warm", intensity: 0.45 };
  if (mood < -0.35) return { emotion: "concerned", intensity: 0.45 };

  // Default
  return { emotion: "neutral", intensity: 0.4 };
}

export { clamp01, pickEmotion };
