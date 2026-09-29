import { assert, it } from "@effect/vitest";
import {
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeRetainedCopyId,
  type Acquisition,
} from "@smolai/skit-core";
import { restorableSource } from "../src/workflows/library/library-sync.js";

const acquisition = (overrides: Partial<Acquisition>): Acquisition => ({
  acquisition_id: makeAcquisitionId(),
  collection_id: makeCollectionId(),
  kind: "source",
  retained_copy_id: makeRetainedCopyId(),
  source_identity: {
    kind: "github",
    owner: "acme",
    repository: "skills",
    collection_root: "skills",
  },
  input: { value: "https://github.com/acme/skills/tree/main/skills" },
  revision: "e0219e96214ac420bdb8d15141340625fda63bbb",
  acquired_at: "2026-09-16T00:00:00.000Z",
  machine_id: makeMachineId(),
  observations: [],
  ...overrides,
});

it("restores a Git Source from its identity and collection root, not its input", () => {
  assert.deepStrictEqual(restorableSource(acquisition({})), {
    type: "github",
    owner: "acme",
    repository: "skills",
    subpath: "skills",
  });
  assert.deepStrictEqual(
    restorableSource(
      acquisition({
        source_identity: {
          kind: "git",
          remote: { value: "git@git.corp.example:agents/tools.git" },
          collection_root: ".",
        },
      }),
    ),
    { type: "git", remote: "git@git.corp.example:agents/tools.git" },
  );
});

it("restores a Registry Source at its recorded Release", () => {
  assert.deepStrictEqual(
    restorableSource(
      acquisition({
        source_identity: {
          kind: "registry",
          authority: "https://registry.example",
          namespace: "tim",
          slug: "tools",
        },
        input: { value: "skit://registry.example/tim/tools" },
        revision: "1.2.0",
      }),
    ),
    {
      type: "registry",
      namespace: "tim",
      slug: "tools",
      version: "1.2.0",
      authority: "https://registry.example",
    },
  );
  const { revision: _revision, ...unpinned } = acquisition({
    source_identity: { kind: "registry", authority: "default", namespace: "tim", slug: "tools" },
  });
  assert.strictEqual(restorableSource(unpinned), undefined);
});
