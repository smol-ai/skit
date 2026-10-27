import { Schema } from "effect";

// Domain vocabulary shared by the Library store, the wire contracts, and Harness code.
export const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u));
export type Digest = typeof Digest.Type;
export const HarnessName = Schema.Literals(["codex", "claude-code", "opencode", "devin"]);
export type HarnessName = typeof HarnessName.Type;
/**
 * Where SKIT materializes Skills. `agents` is the shared `.agents/skills` root read by Codex,
 * OpenCode, Devin, Cursor, and Pi; `claude` exists because Claude Code does not read it.
 */
export const InstallDestination = Schema.Literals(["agents", "claude"]);
export type InstallDestination = typeof InstallDestination.Type;
/**
 * A recorded installed skill's target. `legacy` marks a copy at a former per-Harness directory; it is
 * never desired, so reconciliation retires it under the ordinary custody checks.
 */
export const RecordedInstallDestination = Schema.Literals(["agents", "claude", "legacy"]);
export type RecordedInstallDestination = typeof RecordedInstallDestination.Type;
export const InvocationPolicy = Schema.Literals(["explicit", "implicit", "host-policy"]);
export type InvocationPolicy = typeof InvocationPolicy.Type;
export const SkitBindingScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("repository"), root: Schema.String }),
]);
export type SkitBindingScope = typeof SkitBindingScope.Type;

export const SkitValidationDiagnostic = Schema.Struct({
  code: Schema.String,
  severity: Schema.Literals(["info", "warning", "error"]),
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
});
export type SkitValidationDiagnostic = typeof SkitValidationDiagnostic.Type;
