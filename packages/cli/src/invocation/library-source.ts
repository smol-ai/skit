import type { DeclaredInvocationResolution } from "@smolai/skit-core";

/** An author who declared no invocation policy, for Skills SKIT has no declaration for. */
export function unspecifiedDeclaredInvocation(): Omit<DeclaredInvocationResolution, "harness"> {
  return {
    policy: "unspecified",
    source: { kind: "unspecified" },
    declarations: [],
    conformance: { state: "conforming" },
  };
}
