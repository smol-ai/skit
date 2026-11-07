import { Schema } from "effect";
/**
 * Where SKIT materializes Skills. `agents` is the shared `.agents/skills` root read by Codex,
 * OpenCode, Devin, Cursor, and Pi; `claude` exists because Claude Code does not read it.
 */
export const InstallDestination = Schema.Literals(["agents", "claude"]);
export type InstallDestination = typeof InstallDestination.Type;
