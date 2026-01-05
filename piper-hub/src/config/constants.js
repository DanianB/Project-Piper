export const DEFAULT_PORT = Number(process.env.PORT || 3000);
export const OFF_EXIT_CODE = 99;

export const LIMITS = {
  jsonBody: "20mb",
  snapshotMaxCharsPerFile: 16000,
  snapshotMaxFiles: 8,
};

export const ALLOWLIST_SNAPSHOT_FILES = [
  "public/index.html",
  "public/styles.css",
  "src/server.js",
  "src/routes/chat.js",
  "src/routes/actions.js",
  "src/planner/planner.js",
  "src/planner/compiler.js",
  "data/apps.json",
];
