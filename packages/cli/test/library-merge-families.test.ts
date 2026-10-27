import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  currentLibraryManifest,
  librarySnapshotDigests,
  LibraryManifest,
  makeImportId,
  makeCollectionId,
  makeMachineId,
  makeCollectionVersionId,
  makeSkillId,
  makeSkillVersionId,
  type Import,
  type BindingEntry,
  type Collection,
  type CollectionId,
  type CollectionVersion,
  type Skill,
  type SkillId,
  type SkillVersion,
} from "@smolai/skit-core";
import { mergeLibraryManifests } from "../src/workflows/library/library-merge.js";

// Each family below is built so that its outcome is known by construction from the merge rules in
// docs/library-sync-outcomes.md: which records each side changed relative to the base, and which
// of those changes collide. Families own disjoint Collections, so a combination of families must
// merge to the union of their outcomes. No case is classified by running the merge.

const machineId = makeMachineId();
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** One side's records for one family. */
interface Side {
  readonly collections: readonly Collection[];
  readonly skills: readonly Skill[];
  readonly retained_copies: readonly CollectionVersion[];
  readonly acquisitions: readonly Import[];
  readonly entries: readonly BindingEntry[];
}
const none: Side = {
  collections: [],
  skills: [],
  retained_copies: [],
  acquisitions: [],
  entries: [],
};

interface Observation {
  readonly acquisition: Import;
  readonly copy: CollectionVersion;
  readonly versions: Readonly<Record<string, SkillVersion>>;
}

/**
 * A Collection whose Skills sit at `paths`. The same bytes at the same path always yield the same
 * Version handle, as after Version alignment; different bytes or a different source yield a new one.
 */
const fixture = (paths: readonly string[]) => {
  const collection_id = makeCollectionId();
  const skillIds: Record<string, SkillId> = Object.fromEntries(
    paths.map((path) => [path, makeSkillId()]),
  );
  const versions = new Map<string, SkillVersion>();
  const version = (path: string, bytes: string, source = bytes) => {
    const key = `${path}\0${bytes}\0${source}`;
    const existing = versions.get(key);
    if (existing !== undefined) return existing;
    const created: SkillVersion = {
      skill_version_id: makeSkillVersionId(),
      source_digest: digest(`source:${source}`),
      artifact_digest: digest(`artifact:${bytes}`),
      validation_identity_digest: digest(`artifact:${bytes}`),
      materialization_profile: "plain-skill/v1",
    };
    versions.set(key, created);
    return created;
  };
  const acquire = (
    kind: Import["kind"],
    members: Readonly<Record<string, SkillVersion>>,
    at: string,
  ): Omit<Observation, "versions"> => {
    const retained_copy_id = makeCollectionVersionId();
    const copy: CollectionVersion = {
      retained_copy_id,
      digest: digest(canonicalJson(members)),
      copy_profile: "verbatim/v1",
      members: Object.entries(members).map(([path, item]) => ({
        source_path: kind === "source" ? path : ".",
        source_digest: item.source_digest,
        artifact_digest: item.artifact_digest,
        materialization_profile: item.materialization_profile,
      })),
    };
    return {
      copy,
      acquisition: {
        acquisition_id: makeImportId(),
        collection_id,
        kind,
        retained_copy_id,
        source_identity: {
          kind: "local",
          machine_id: machineId,
          path: { value: `/src/${collection_id}` },
        },
        input: { value: `/src/${collection_id}` },
        acquired_at: at,
        machine_id: machineId,
        observations: [],
      },
    };
  };
  return {
    collection_id,
    skillIds,
    /** A source import of every path; `sources` overrides a path's source bytes. */
    observe: (
      bytes: Readonly<Record<string, string>>,
      at = "2026-01-01T00:00:00.000Z",
      sources: Readonly<Record<string, string>> = {},
    ): Observation => {
      const observed = Object.fromEntries(
        paths.map((path) => [path, version(path, bytes[path] ?? path, sources[path])]),
      );
      return { ...acquire("source", observed, at), versions: observed };
    },
    /** A retained local edit of one Skill. */
    edit: (path: string, bytes: string, at = "2026-01-01T00:00:00.000Z"): Observation => {
      const edited = { [path]: version(path, bytes) };
      return { ...acquire("retained-edit", edited, at), versions: edited };
    },
    /** This Collection as one side holds it. */
    held: (
      observations: readonly Observation[],
      options: {
        label?: string;
        entries?: readonly BindingEntry[];
        selected?: Readonly<Record<string, SkillVersion>>;
      } = {},
    ): Side => ({
      collections: [{ collection_id, label: options.label ?? "fixture" }],
      skills: paths.map((path) => {
        const versions: SkillVersion[] = [];
        for (const observation of observations) {
          const item = observation.versions[path];
          if (
            item !== undefined &&
            !versions.some((other) => other.artifact_digest === item.artifact_digest)
          )
            versions.push(item);
        }
        const selected = options.selected?.[path];
        return {
          skill_id: skillIds[path]!,
          collection_id,
          path,
          name: path,
          ...(selected === undefined ? {} : { local_version_id: selected.skill_version_id }),
          versions,
        };
      }),
      retained_copies: observations.map((item) => item.copy),
      acquisitions: observations.map((item) => item.acquisition),
      entries: options.entries ?? [],
    }),
  };
};

const skill = (id: SkillId): BindingEntry => ({ kind: "skill", skill_id: id });

interface Family {
  readonly base: Side;
  readonly local: Side;
  readonly remote: Side;
  /** Sorted conflict keys; empty for a conflict-free family. */
  readonly conflicts: readonly string[];
  /** The merge when conflict-free, or the result of taking remote for every conflict. */
  readonly resolved: Side | "unresolvable";
  /** Whether swapping local and remote yields the same keys and, when conflict-free, records. */
  readonly symmetric: boolean;
  /** Records already aligned from independent imports, as sync passes them to the merge. */
  readonly imports?: {
    readonly skills: readonly SkillId[];
    readonly collections: readonly CollectionId[];
  };
}

const later = "2026-01-02T00:00:00.000Z";

const families = {
  // Conflict-free.
  "added on one side": (): Family => {
    const x = fixture(["alpha"]);
    const held = x.held([x.observe({})]);
    return {
      base: none,
      local: none,
      remote: held,
      conflicts: [],
      resolved: held,
      symmetric: true,
    };
  },
  "removed on one side": (): Family => {
    const x = fixture(["alpha"]);
    const held = x.held([x.observe({})]);
    return {
      base: held,
      local: held,
      remote: none,
      conflicts: [],
      resolved: none,
      symmetric: true,
    };
  },
  "relabelled on one side": (): Family => {
    const x = fixture(["alpha"]);
    const first = x.observe({});
    const relabelled = x.held([first], { label: "renamed" });
    return {
      base: x.held([first]),
      local: x.held([first]),
      remote: relabelled,
      conflicts: [],
      resolved: relabelled,
      symmetric: true,
    };
  },
  "updated on one side": (): Family => {
    const x = fixture(["alpha", "beta"]);
    const first = x.observe({});
    const updated = x.held([first, x.observe({ alpha: "alpha v2" }, later)]);
    return {
      base: x.held([first]),
      local: x.held([first]),
      remote: updated,
      conflicts: [],
      resolved: updated,
      symmetric: true,
    };
  },
  "the same update on both sides": (): Family => {
    const x = fixture(["alpha", "beta"]);
    const first = x.observe({});
    const updated = x.held([first, x.observe({ alpha: "alpha v2" }, later)]);
    return {
      base: x.held([first]),
      local: updated,
      remote: updated,
      conflicts: [],
      resolved: updated,
      symmetric: true,
    };
  },
  "different Skills enabled on each side": (): Family => {
    const x = fixture(["alpha", "beta"]);
    const first = x.observe({});
    return {
      base: x.held([first]),
      local: x.held([first], { entries: [skill(x.skillIds.alpha!)] }),
      remote: x.held([first], { entries: [skill(x.skillIds.beta!)] }),
      conflicts: [],
      resolved: x.held([first], {
        entries: [skill(x.skillIds.alpha!), skill(x.skillIds.beta!)],
      }),
      symmetric: true,
    };
  },
  "a removal beats enabling its Skill": (): Family => {
    const x = fixture(["alpha", "beta"]);
    const first = x.observe({});
    return {
      base: x.held([first]),
      local: none,
      remote: x.held([first], { entries: [skill(x.skillIds.alpha!)] }),
      conflicts: [],
      resolved: none,
      symmetric: true,
    };
  },
  "different records of one Collection change on each side": (): Family => {
    const x = fixture(["alpha", "beta"]);
    const first = x.observe({});
    const second = x.observe({ beta: "beta v2" }, later);
    return {
      base: x.held([first]),
      local: x.held([first], { label: "renamed" }),
      remote: x.held([first, second]),
      conflicts: [],
      resolved: x.held([first, second], { label: "renamed" }),
      symmetric: true,
    };
  },
  "identical bytes in distinct Collections stay distinct": (): Family => {
    const x = fixture(["alpha"]);
    const y = fixture(["alpha"]);
    const mine = x.held([x.observe({ alpha: "same" })]);
    const theirs = y.held([y.observe({ alpha: "same" })]);
    return {
      base: none,
      local: mine,
      remote: theirs,
      conflicts: [],
      resolved: {
        collections: [...mine.collections, ...theirs.collections],
        skills: [...mine.skills, ...theirs.skills],
        retained_copies: [...mine.retained_copies, ...theirs.retained_copies],
        acquisitions: [...mine.acquisitions, ...theirs.acquisitions],
        entries: [],
      },
      symmetric: true,
    };
  },
  // Conflicting.
  "relabelled differently": (): Family => {
    const x = fixture(["alpha"]);
    const first = x.observe({});
    const theirs = x.held([first], { label: "remote" });
    return {
      base: x.held([first]),
      local: x.held([first], { label: "local" }),
      remote: theirs,
      conflicts: [`collection:${x.collection_id}`],
      resolved: theirs,
      symmetric: true,
    };
  },
  "removed while updated": (): Family => {
    const x = fixture(["alpha", "beta"]);
    const first = x.observe({});
    const updated = x.held([first, x.observe({ alpha: "alpha v2" }, later)]);
    return {
      base: x.held([first]),
      local: none,
      remote: updated,
      // One Collection choice, not separate Skill and import keys.
      conflicts: [`collection:${x.collection_id}`],
      resolved: updated,
      symmetric: true,
    };
  },
  "one Skill updated differently": (): Family => {
    const x = fixture(["alpha", "beta"]);
    const first = x.observe({});
    const mine = x.observe({ alpha: "alpha local" }, later);
    const theirs = x.observe({ alpha: "alpha remote" }, later);
    const remote = x.held([first, theirs]);
    return {
      base: x.held([first]),
      local: x.held([first, mine]),
      remote,
      conflicts: [`skill:${x.skillIds.alpha}`],
      // Taking the remote Skill keeps both imports and their bytes.
      resolved: {
        ...remote,
        retained_copies: [...remote.retained_copies, mine.copy],
        acquisitions: [...remote.acquisitions, mine.acquisition],
      },
      symmetric: true,
    };
  },
  "following a Collection while disabling one of its Skills": (): Family => {
    const x = fixture(["alpha", "beta"]);
    const first = x.observe({});
    const both = [skill(x.skillIds.alpha!), skill(x.skillIds.beta!)];
    return {
      base: x.held([first], { entries: both }),
      local: x.held([first], { entries: [{ kind: "collection", collection_id: x.collection_id }] }),
      remote: x.held([first], { entries: [skill(x.skillIds.beta!)] }),
      conflicts: ["binding:global"],
      resolved: x.held([first], { entries: [skill(x.skillIds.beta!)] }),
      symmetric: true,
    };
  },
  "an empty base with the same Collection held differently": (): Family => {
    const x = fixture(["alpha"]);
    const first = x.observe({});
    const theirs = x.held([first], { label: "remote" });
    return {
      base: none,
      local: x.held([first], { label: "local" }),
      remote: theirs,
      conflicts: [`collection:${x.collection_id}`],
      resolved: theirs,
      symmetric: true,
    };
  },
  // Aligned independent imports: the same upstream added on both sides under one identity.
  "an aligned import with the same selection": (): Family => {
    const x = fixture(["alpha"]);
    const mine = x.observe({ alpha: "same" });
    const theirs = x.observe({ alpha: "same" });
    return {
      base: none,
      local: x.held([mine]),
      remote: x.held([theirs]),
      conflicts: [],
      // Compatible histories combine.
      resolved: x.held([theirs, mine]),
      symmetric: false,
      imports: { skills: [x.skillIds.alpha!], collections: [x.collection_id] },
    };
  },
  "an aligned import with a different selection and older local history": (): Family => {
    const x = fixture(["alpha"]);
    const mine = x.observe({ alpha: "local" });
    const theirs = x.observe({ alpha: "remote" }, later);
    const remote = x.held([theirs]);
    return {
      base: none,
      local: x.held([mine]),
      remote,
      conflicts: [`collection:${x.collection_id}`],
      // The strictly older local import is kept as history; the Skill takes remote Versions.
      resolved: {
        ...remote,
        retained_copies: [...remote.retained_copies, mine.copy],
        acquisitions: [...remote.acquisitions, mine.acquisition],
      },
      symmetric: false,
      imports: { skills: [x.skillIds.alpha!], collections: [x.collection_id] },
    };
  },
  "an equal artifact digest with a different source digest": (): Family => {
    const x = fixture(["alpha"]);
    const mine = x.observe({ alpha: "same" }, undefined, { alpha: "local source" });
    const theirs = x.observe({ alpha: "same" }, later, { alpha: "remote source" });
    const remote = x.held([theirs]);
    assert.strictEqual(
      mine.versions.alpha!.artifact_digest,
      theirs.versions.alpha!.artifact_digest,
    );
    assert.notStrictEqual(
      mine.versions.alpha!.skill_version_id,
      theirs.versions.alpha!.skill_version_id,
    );
    return {
      base: none,
      local: x.held([mine]),
      remote,
      conflicts: [`collection:${x.collection_id}`],
      resolved: {
        ...remote,
        retained_copies: [...remote.retained_copies, mine.copy],
        acquisitions: [...remote.acquisitions, mine.acquisition],
      },
      symmetric: false,
      imports: { skills: [x.skillIds.alpha!], collections: [x.collection_id] },
    };
  },
  "an aligned import whose local Skill selects a retained edit": (): Family => {
    const x = fixture(["alpha"]);
    const mine = x.observe({ alpha: "same" });
    const edited = x.edit("alpha", "edit");
    return {
      base: none,
      local: x.held([mine, edited], { selected: { alpha: edited.versions.alpha! } }),
      remote: x.held([x.observe({ alpha: "same" })]),
      conflicts: [`collection:${x.collection_id}`],
      // Taking remote would discard the local edit, so the conflict stays.
      resolved: "unresolvable",
      symmetric: false,
      imports: { skills: [x.skillIds.alpha!], collections: [x.collection_id] },
    };
  },
} satisfies Record<string, () => Family>;
type FamilyName = keyof typeof families;

const manifestOf = (sides: readonly Side[]): LibraryManifest => {
  const retained_copies = sides.flatMap((side) => side.retained_copies);
  const acquisitions = sides.flatMap((side) => side.acquisitions);
  const entries = sides.flatMap((side) => side.entries);
  return Schema.decodeUnknownSync(LibraryManifest)(
    currentLibraryManifest({
      collections: sides.flatMap((side) => side.collections),
      skills: sides.flatMap((side) => side.skills),
      retained_copies,
      acquisitions,
      snapshot_digests: librarySnapshotDigests({ retained_copies, acquisitions }),
      bindings: entries.length === 0 ? [] : [{ scope: { kind: "global" }, entries }],
    }),
  );
};

/** Order-insensitive identity of a manifest, computed without the merge module. */
const canonical = (manifest: LibraryManifest) => {
  const sorted = <T>(records: readonly T[], key: (record: T) => string) =>
    [...records].sort((left, right) => key(left).localeCompare(key(right)));
  return canonicalJson({
    ...manifest,
    collections: sorted(manifest.collections, (item) => item.collection_id),
    skills: sorted(
      manifest.skills.map((item) => ({
        ...item,
        versions: sorted(item.versions, (version) => version.skill_version_id),
      })),
      (item) => item.skill_id,
    ),
    retained_copies: sorted(manifest.retained_copies, (item) => item.retained_copy_id),
    acquisitions: sorted(manifest.acquisitions, (item) => item.acquisition_id),
    snapshot_digests: [...manifest.snapshot_digests].sort(),
    bindings: manifest.bindings.map((binding) => ({
      ...binding,
      entries: sorted(binding.entries, (entry) =>
        entry.kind === "collection" ? entry.collection_id : entry.skill_id,
      ),
    })),
  });
};

const merge = (
  cases: readonly Family[],
  swap = false,
  takeRemote: ReadonlySet<string> = new Set(),
) =>
  mergeLibraryManifests(
    manifestOf(cases.map((item) => item.base)),
    manifestOf(cases.map((item) => (swap ? item.remote : item.local))),
    manifestOf(cases.map((item) => (swap ? item.local : item.remote))),
    takeRemote,
    cases.flatMap((item) => item.imports?.skills ?? []),
    cases.flatMap((item) => item.imports?.collections ?? []),
  );

const names = Object.keys(families) as FamilyName[];
const combination = Schema.Array(Schema.Literals(names)).check(Schema.isBetweenLength(1, 5));

for (const name of names)
  it(`family: ${name}`, () => {
    const family = families[name]();
    assert.deepStrictEqual(merge([family]).conflicts, family.conflicts);
    const resolved = merge([family], false, new Set(family.conflicts));
    if (family.resolved === "unresolvable")
      assert.deepStrictEqual(resolved.conflicts, family.conflicts);
    else {
      assert.deepStrictEqual(resolved.conflicts, []);
      assert.isTrue(Schema.is(LibraryManifest)(resolved.manifest));
      assert.strictEqual(canonical(resolved.manifest), canonical(manifestOf([family.resolved])));
    }
  });

it.prop(
  "a combination of families merges to the union of their outcomes",
  [combination],
  ([chosen]) => {
    const cases = chosen.map((name) => families[name]());
    const conflicts = [...new Set(cases.flatMap((item) => item.conflicts))].sort();
    const merged = merge(cases);
    assert.deepStrictEqual(merged.conflicts, conflicts);
    if (conflicts.length === 0) {
      assert.isTrue(Schema.is(LibraryManifest)(merged.manifest));
      assert.strictEqual(
        canonical(merged.manifest),
        canonical(manifestOf(cases.map((item) => item.resolved as Side))),
      );
    }
    if (cases.every((item) => item.symmetric)) {
      const swapped = merge(cases, true);
      assert.deepStrictEqual(swapped.conflicts, conflicts);
      if (conflicts.length === 0)
        assert.strictEqual(canonical(swapped.manifest), canonical(merged.manifest));
    }
  },
);

it.prop(
  "taking remote for every conflict yields each family's remote choice",
  [combination],
  ([chosen]) => {
    const cases = chosen.map((name) => families[name]());
    const conflicts = new Set(cases.flatMap((item) => item.conflicts));
    const resolved = merge(cases, false, conflicts);
    const remaining = [
      ...new Set(cases.flatMap((item) => (item.resolved === "unresolvable" ? item.conflicts : []))),
    ].sort();
    assert.deepStrictEqual(resolved.conflicts, remaining);
    if (remaining.length > 0) return;
    // Taking the global Binding adopts remote's entries for every surviving record.
    const sides = cases.map((item) => item.resolved as Side);
    const present = new Set<string>(
      sides.flatMap((side) => [
        ...side.collections.map((record) => record.collection_id),
        ...side.skills.map((record) => record.skill_id),
      ]),
    );
    const expected = conflicts.has("binding:global")
      ? sides.map((side, index) => ({
          ...side,
          entries: cases[index]!.remote.entries.filter((entry) =>
            present.has(entry.kind === "collection" ? entry.collection_id : entry.skill_id),
          ),
        }))
      : sides;
    assert.isTrue(Schema.is(LibraryManifest)(resolved.manifest));
    assert.strictEqual(canonical(resolved.manifest), canonical(manifestOf(expected)));
  },
);
