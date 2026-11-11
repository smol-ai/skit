import { expectTypeOf, test } from "vitest";
import type { CollectionVersion, Import } from "../src/library/library-contracts.js";
import type { inspectAuthoredSkills } from "../src/library/update-authored-skills.js";

test("authored preview requires the resolved authored import and previous Collection Version", () => {
  type PreviewImport = Parameters<typeof inspectAuthoredSkills>[2];
  expectTypeOf<Import>().not.toExtend<PreviewImport>();
  expectTypeOf<PreviewImport["source_identity"]>().toEqualTypeOf<
    Extract<Import["source_identity"], { readonly kind: "authored-workspace" }>
  >();
  expectTypeOf<Parameters<typeof inspectAuthoredSkills>[3]>().toEqualTypeOf<CollectionVersion>();
});
