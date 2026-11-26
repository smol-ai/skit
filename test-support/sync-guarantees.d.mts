import type sections from "./sync-guarantees.json" with { type: "json" };

type Guarantees = typeof sections;
type GuaranteeKey = { [Section in keyof Guarantees]: keyof Guarantees[Section] }[keyof Guarantees];
export function syncGuarantee(
  describe: (title: string, tests: () => void) => unknown,
  key: GuaranteeKey,
  tests: () => void,
): void;
