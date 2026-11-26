import { expectTypeOf, test } from "vitest";
import type { CollectionVersion, Import } from "../src/library/library-contracts.js";
import type { inspectAuthoredSkills } from "../src/library/update-authored-skills.js";

test("authored preview takes the import, resolved local workspace and previous Collection Version", () => {
  type Args = Parameters<typeof inspectAuthoredSkills>;
  expectTypeOf<Args[2]>().toEqualTypeOf<Import>();
  expectTypeOf<Args[3]>().toEqualTypeOf<{ readonly workspaceId: string; readonly path: string }>();
  expectTypeOf<Args[4]>().toEqualTypeOf<CollectionVersion>();
});
