import { Effect } from "effect";
import { expect, it } from "vitest";
import { readSystemMap } from "../src/atlas/system-map.ts";

const source = { file: "packages/skit/src/author/internal/workspace.ts", line: 10 };
const member = {
  key: "t1",
  name: "AuthorWorkspace",
  ...source,
  declarations: [source.file],
  incomplete: false,
};
const stop = { ...source, reason: "Provided at the command boundary, origin not resolved" };
const fixture = {
  sourceFingerprint: "fixture",
  services: [
    {
      id: `${source.file}#AuthorWorkspace`,
      name: "AuthorWorkspace",
      identifier: "skit/author/AuthorWorkspace",
      kind: "Service",
      ...source,
      operations: [],
    },
  ],
  providers: [
    {
      name: "workspaceLayer",
      ...source,
      provides: [member],
      requires: [],
      incomplete: true,
      notes: ["errors include unresolved members"],
    },
  ],
  commands: [
    {
      command: "author publish",
      ...source,
      requirements: [{ ...member, providers: [], stops: [stop] }],
      incompleteErrors: true,
      notes: ["errors include unresolved members"],
      stops: [{ ...source, reason: "unbound-callback" }],
    },
  ],
  stops: [{ ...source, reason: "unbound-callback" }],
  elapsedMs: 12,
  compiler: {
    typescript: "7.1.0-beta",
    tsrs: "0.20.0-ts7.1.0-beta",
    typescriptCommit: "fixture",
    fingerprint: "fixture",
  },
};

it("keeps incomplete channels and provider stops while linking exact declarations", async () => {
  const map = await Effect.runPromise(readSystemMap(fixture, []));
  expect(map.services[0]?.providers[0]?.incomplete).toBe(true);
  expect(map.commands[0]?.incompleteErrors).toBe(true);
  expect(map.commands[0]?.requirements[0]?.service).toBe(map.services[0]?.id);
  expect(map.commands[0]?.requirements[0]?.providers).toEqual([]);
  expect(map.commands[0]?.requirements[0]?.stops).toEqual([stop]);
  expect(map.stops).toEqual(fixture.stops);
});

it("does not attach a same-named provider declared in another file", async () => {
  const map = await Effect.runPromise(
    readSystemMap(
      {
        ...fixture,
        providers: [
          {
            ...fixture.providers[0],
            provides: [{ ...member, declarations: ["packages/cli/src/other.ts"] }],
          },
        ],
      },
      [],
    ),
  );
  expect(map.services[0]?.providers).toEqual([]);
});

it("merges command factory occurrences without losing their distinct provider answers", async () => {
  const provider = { ...source, name: "chosenLayer" };
  const map = await Effect.runPromise(
    readSystemMap(
      {
        ...fixture,
        commands: [
          ...fixture.commands,
          {
            ...fixture.commands[0],
            requirements: [{ ...member, providers: [provider], stops: [] }],
          },
        ],
      },
      [],
    ),
  );
  expect(map.commands).toHaveLength(1);
  expect(map.commands[0]?.requirements).toHaveLength(1);
  expect(map.commands[0]?.requirements[0]?.stops).toContainEqual(stop);
  expect(map.commands[0]?.requirements[0]?.providers).toEqual([]);
  expect(map.commands[0]?.requirements[0]?.candidates).toEqual([
    {
      ...provider,
      requires: [],
      incomplete: true,
      notes: ["Provider requirements are not recorded"],
      dependencies: [],
    },
  ]);
  expect(map.commands[0]?.sources).toHaveLength(2);
});

it("fails decoding when an extraction drops its source anchors", async () => {
  const result = await Effect.runPromiseExit(
    readSystemMap({ ...fixture, stops: [{ reason: "unbound-callback" }] }, []),
  );
  expect(result._tag).toBe("Failure");
});
