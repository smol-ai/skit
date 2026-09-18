import { posix } from "node:path";
import { Result, Schema } from "effect";
import type { SkitDescriptor } from "../contracts.js";
import type { HarnessMetadataInvalid } from "../failures.js";
import { InvocationPolicy } from "../library/store/state-schema.js";
import {
  expectedNativeInvocation,
  INVOCATION_HARNESSES,
  invocationMetadataAdapters,
  InvocationHarness,
  AUTHORED_INVOCATION_HARNESSES,
  type AuthoredInvocationHarness,
  requiresAuthoredInvocation,
} from "../harnesses/invocation-metadata.js";

/** The command an Author runs to bring a Skill's native metadata into conformance. */
export const INVOCATION_GENERATION_COMMAND = "skit author invocation";

export type DeclaringSkill = Pick<SkitDescriptor["skills"][number], "name" | "path" | "invocation">;

export interface InvocationConformanceIssue {
  skill: string;
  harness: AuthoredInvocationHarness;
  /** Metadata file, relative to the SKIT root. */
  path: string;
  field: string;
  policy: InvocationPolicy;
  expected: boolean | undefined;
  actual: boolean | undefined;
}

/**
 * Report every declared Skill whose own native metadata does not yet express its declaration.
 * A Skill that declares nothing is skipped: its native metadata is the author's and governs.
 */
export function assessInvocationConformance(
  skills: readonly DeclaringSkill[],
  readText: (path: string) => string | undefined,
): InvocationConformanceIssue[] {
  const issues: InvocationConformanceIssue[] = [];
  for (const skill of skills) {
    if (!skill.invocation) continue;
    for (const harness of AUTHORED_INVOCATION_HARNESSES) {
      const adapter = invocationMetadataAdapters[harness];
      const path = posix.join(skill.path, adapter.file);
      const text = readText(path);
      if (text === undefined && adapter.required) continue;
      const expected = expectedNativeInvocation(harness, skill.invocation);
      // The Registry Worker calls this and has no `effect` dependency, so the failure cannot be
      // returned as a Result without pulling Effect's types across the workerd boundary that
      // 7fb7d77 established. This is the one place the tagged error is still thrown.
      const actual = Result.getOrThrow(adapter.read(text, path));
      if (actual === expected) continue;
      issues.push({
        skill: skill.name,
        harness,
        path,
        field: adapter.field,
        policy: skill.invocation,
        expected,
        actual,
      });
    }
  }
  return issues;
}

export function describeInvocationConformanceIssue(issue: InvocationConformanceIssue): string {
  const requirement =
    issue.expected === undefined
      ? `must not set ${issue.field}`
      : `must set ${issue.field}: ${issue.expected}`;
  const found = issue.actual === undefined ? "the field is absent" : `found ${issue.actual}`;
  return `${issue.skill} declares invocation ${issue.policy}, so its ${issue.harness} metadata ${issue.path} ${requirement} (${found}); run \`${INVOCATION_GENERATION_COMMAND}\` to write it`;
}

export const ResolvedDeclaredPolicy = Schema.Union([
  InvocationPolicy,
  Schema.Literal("unspecified"),
]);
export type ResolvedDeclaredPolicy = typeof ResolvedDeclaredPolicy.Type;

export const DeclaredInvocation = Schema.Union([
  Schema.Struct({ origin: Schema.Literal("skit-declaration"), policy: InvocationPolicy }),
  Schema.Struct({
    origin: Schema.Literal("native-metadata"),
    policy: InvocationPolicy,
    path: Schema.String,
    field: Schema.String,
  }),
]);
export type DeclaredInvocation = typeof DeclaredInvocation.Type;

export const DeclaredPolicySource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("skit-declaration") }),
  Schema.Struct({
    kind: Schema.Literal("native-metadata"),
    path: Schema.String,
    field: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("unspecified") }),
]);
export type DeclaredPolicySource = typeof DeclaredPolicySource.Type;

/**
 * Whether the Skill's own metadata demonstrates its declaration.
 *
 * `unverified-legacy` is the Release published before the invariant landed: it declares a policy
 * and carries no native field either way, so the artifact evidences nothing and must not be
 * described as compatible. `non-conforming` is a field that contradicts the declaration, which is
 * a defect for the author to repair rather than a precedence for a reader to apply.
 */
export const InvocationConformance = Schema.Union([
  Schema.Struct({ state: Schema.Literal("conforming") }),
  Schema.Struct({
    state: Schema.Literal("unverified-legacy"),
    path: Schema.String,
    field: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("non-conforming"),
    path: Schema.String,
    field: Schema.String,
    declared: InvocationPolicy,
    native: InvocationPolicy,
  }),
]);
export type InvocationConformance = typeof InvocationConformance.Type;

export const DeclaredInvocationResolution = Schema.Struct({
  harness: InvocationHarness,
  /** The author's declared policy for this Harness, or `unspecified` when neither form declares. */
  policy: ResolvedDeclaredPolicy,
  source: DeclaredPolicySource,
  /** Every declaration found, so a SKIT-versus-native disagreement stays visible. */
  declarations: Schema.Array(DeclaredInvocation),
  conformance: InvocationConformance,
});
export type DeclaredInvocationResolution = typeof DeclaredInvocationResolution.Type;

/** The policy a Harness's native field states. Absence declares nothing: it is not `host-policy`. */
function nativePolicy(harness: InvocationHarness, value: boolean | undefined) {
  if (value === undefined) return undefined;
  if (harness === "claude-code") return value ? "explicit" : "implicit";
  return value ? "implicit" : "explicit";
}

function resolveConformance(
  declared: InvocationPolicy | undefined,
  native: InvocationPolicy | undefined,
  harness: InvocationHarness,
  path: string,
  field: string,
): InvocationConformance {
  if (!declared || !requiresAuthoredInvocation(harness)) return { state: "conforming" };
  const expected = expectedNativeInvocation(harness, declared);
  if (expected === undefined)
    return native === undefined
      ? { state: "conforming" }
      : { state: "non-conforming", path, field, declared, native };
  if (native === undefined) return { state: "unverified-legacy", path, field };
  return native === declared
    ? { state: "conforming" }
    : { state: "non-conforming", path, field, declared, native };
}

/**
 * The author's intent for one Skill, per Harness, as the artifact states it.
 *
 * The SKIT declaration is the intent; native metadata is read only where none exists, which is how
 * a Skill adopted from the Agent Skills ecosystem still reports an author default. Read this from
 * the Library's retained copy, never a Projection: a locally edited Projection is not author intent.
 */
export function resolveDeclaredInvocation(
  skill: DeclaringSkill,
  readText: (path: string) => string | undefined,
): Result.Result<Record<InvocationHarness, DeclaredInvocationResolution>, HarnessMetadataInvalid> {
  const resolutions = {} as Record<InvocationHarness, DeclaredInvocationResolution>;
  for (const harness of INVOCATION_HARNESSES) {
    const adapter = invocationMetadataAdapters[harness];
    const path = posix.join(skill.path, adapter.file);
    const read = adapter.read(readText(path), path);
    if (Result.isFailure(read)) return Result.fail(read.failure);
    const native = nativePolicy(harness, read.success);
    const declarations: DeclaredInvocation[] = [];
    if (skill.invocation)
      declarations.push({ origin: "skit-declaration", policy: skill.invocation });
    if (native)
      declarations.push({ origin: "native-metadata", policy: native, path, field: adapter.field });
    const policy = skill.invocation ?? native ?? "unspecified";
    resolutions[harness] = {
      harness,
      policy,
      source: skill.invocation
        ? { kind: "skit-declaration" }
        : native
          ? { kind: "native-metadata", path, field: adapter.field }
          : { kind: "unspecified" },
      declarations,
      conformance: resolveConformance(skill.invocation, native, harness, path, adapter.field),
    };
  }
  return Result.succeed(resolutions);
}
