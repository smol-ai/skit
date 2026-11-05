/**
 * Target folder layout, checked by lint (skit/directory-layout and skit/import-direction). Declared
 * from Arc work item work_01m6jatvy5f21a7x5q214td7a3, "Restructure SKIT folders around state owners,
 * with shared behaviour in core". Edit the work item and this file together, in a reviewed
 * architecture change.
 *
 * `layout`: per package, the root files and top-level folders allowed directly under `src/`.
 * `undecided`: paths the work item does not place. Lint allows them for now; Tim decides each one,
 * then it moves into `layout` or its existing files fail the layout rule.
 *
 * Every decided source path and frontend import is checked without migration exemptions.
 */
export const layout = {
  "packages/cli/src/": {
    files: ["main.ts", "application.ts"],
    folders: ["commands", "library", "author", "registry", "audit", "terminal", "storybook"],
  },
  "packages/skit/src/": {
    files: ["index.ts"],
    folders: [
      "library",
      "installed-skills",
      "machine-settings",
      "author",
      "artifact",
      "sources",
      "harnesses",
      "history",
      "sync",
      "platform",
      "api",
      // Small primitives most owners use (failure codes, hashes, paths, text). The corpus gives these
      // one home: t3code packages/shared, opencode packages/util. A folder here, not a package.
      "shared",
    ],
  },
  "packages/skit-server-effect/src/": {
    files: ["application.ts", "http.ts"],
    folders: ["identity", "skits", "library", "teams", "feedback", "api", "platform"],
  },
  "packages/tui/src/": {
    files: ["index.ts"],
    folders: ["shell", "library", "audit", "harness", "testing"],
  },
};

export const undecided = [
  // Core folders the work item does not place.
  "packages/skit/src/invocation/",
  "packages/skit/src/auditing/",
  // Package export entry points (./universal/consumer, ./universal/authoring); the work item keeps
  // today's runtime-neutral entry points as compatibility exports.
  "packages/skit/src/universal-consumer.ts",
  "packages/skit/src/universal-authoring.ts",
  // Server folders the work item does not place.
  // The Worker entry (wrangler.jsonc "main").
  "packages/skit-server-effect/src/index.ts",
  // The work item gives Storybook no layout, only an explicit CLI story export.
  "packages/storybook/src/",
];
