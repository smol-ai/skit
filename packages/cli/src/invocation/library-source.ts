import {
  INVOCATION_HARNESSES,
  type InvocationHarness,
  type DeclaredInvocationResolution,
} from "@smolai/skit-core";

export type SkillDeclaredInvocation = Record<InvocationHarness, DeclaredInvocationResolution>;

export function unspecifiedDeclaredInvocation(): SkillDeclaredInvocation {
  const resolutions = {} as SkillDeclaredInvocation;
  for (const harness of INVOCATION_HARNESSES)
    resolutions[harness] = {
      harness,
      policy: "unspecified",
      source: { kind: "unspecified" },
      declarations: [],
      conformance: { state: "conforming" },
    };
  return resolutions;
}
