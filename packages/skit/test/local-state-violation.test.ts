import { expect, test } from "vitest";
import { Result, Schema } from "effect";
import {
  LibraryState,
  LibraryStateDocument,
  emptyLibraryState,
} from "../src/library/library-state.js";
import { LocalStateViolation } from "../src/library/local-state-violation.js";
import { SchemaFailure } from "../src/shared/schema-issue.js";
import { Hash } from "../src/shared/hash.js";
import {
  makeCollectionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";

const hash = Hash.make(`sha256:${"a".repeat(64)}`);
const skillId = makeSkillId();
const collectionId = makeCollectionId();
const installedSkillId = makeInstalledSkillId();
const secondId = makeInstalledSkillId();
const versionId = makeSkillVersionId();
const missingSkill = makeSkillId();
const missingCollection = makeCollectionId();
const missingVersion = makeSkillVersionId();
const row = {
  installed_skill_id: installedSkillId,
  skill_id: skillId,
  skill_version_id: versionId,
  destination: "agents",
  root: "/skills",
  path: "/skills/review",
  expected_hash: hash,
  installed_at: "2026-01-01T00:00:00.000Z",
  status: "installed",
};
const base = Schema.decodeUnknownSync(LibraryState)({
  ...emptyLibraryState(),
  collections: [{ collection_id: collectionId, label: "tools" }],
  skills: [
    {
      skill_id: skillId,
      collection_id: collectionId,
      path: "review",
      name: "review",
      versions: [
        {
          skill_version_id: versionId,
          source_hash: hash,
          artifact_hash: hash,
          validation_identity_hash: hash,
          materialization_profile: "plain-skill/v1",
        },
      ],
    },
  ],
  installed_skills: [row],
});
const cases: readonly {
  name: string;
  change: (state: LibraryState) => unknown;
  expected: LocalStateViolation;
}[] = [
  {
    name: "repository paths resolving to one root",
    change: (s) => ({
      ...s,
      repositories: [
        { root: "/work/repo", enabled: [] },
        { root: "/work/./repo", enabled: [] },
      ],
    }),
    expected: {
      _tag: "RepositoryRootCollision",
      first: "/work/repo",
      second: "/work/./repo",
      canonical: "/work/repo",
    },
  },
  {
    name: "installed paths resolving to one folder",
    change: (s) => ({
      ...s,
      installed_skills: [
        ...s.installed_skills,
        { ...row, installed_skill_id: secondId, path: "/skills/./review" },
      ],
    }),
    expected: {
      _tag: "InstalledPathCollision",
      firstId: installedSkillId,
      secondId,
      firstPath: "/skills/review",
      secondPath: "/skills/./review",
      canonical: "/skills/review",
    },
  },
  {
    name: "duplicate installed identity",
    change: (s) => ({
      ...s,
      installed_skills: [...s.installed_skills, { ...row, path: "/skills/other" }],
    }),
    expected: { _tag: "InstalledIdDuplicate", installedSkillId },
  },
  {
    name: "missing repository Skill",
    change: (s) => ({
      ...s,
      repositories: [{ root: "/work/repo", enabled: [{ skill: missingSkill }] }],
    }),
    expected: {
      _tag: "RepositorySubjectMissing",
      root: "/work/repo",
      kind: "skill",
      id: missingSkill,
    },
  },
  {
    name: "missing repository Collection",
    change: (s) => ({
      ...s,
      repositories: [{ root: "/work/repo", enabled: [{ collection: missingCollection }] }],
    }),
    expected: {
      _tag: "RepositorySubjectMissing",
      root: "/work/repo",
      kind: "collection",
      id: missingCollection,
    },
  },
  {
    name: "missing installed Skill",
    change: (s) => ({ ...s, installed_skills: [{ ...row, skill_id: missingSkill }] }),
    expected: {
      _tag: "InstalledSkillMissing",
      installedSkillId,
      skillId: missingSkill,
      path: row.path,
    },
  },
  {
    name: "missing installed Version",
    change: (s) => ({ ...s, installed_skills: [{ ...row, skill_version_id: missingVersion }] }),
    expected: {
      _tag: "InstalledVersionMissing",
      installedSkillId,
      skillId,
      versionId: missingVersion,
      path: row.path,
    },
  },
];

test.each(cases)("retains $name as native and stored facts", ({ change, expected }) => {
  const result = Schema.decodeUnknownResult(LibraryStateDocument)(change(base));
  if (!Result.isFailure(result)) throw new Error("Invalid local state accepted");
  const wire = Schema.encodeSync(Schema.toCodecJson(SchemaFailure))(result.failure);
  const stored = Schema.decodeUnknownSync(SchemaFailure)(JSON.parse(JSON.stringify(wire)));
  if (stored._tag !== "StoredSchemaFailure") throw new Error("Missing stored schema facts");
  const issue = stored.issues.find(
    (issue) =>
      issue.reason._tag === "InvalidValue" &&
      issue.reason.check?.id === "skit/schema/library-local-state",
  );
  if (issue?.reason._tag !== "InvalidValue") throw new Error("Missing local state violation");
  expect(Schema.decodeUnknownSync(LocalStateViolation)(issue.reason.check?.payload)).toEqual(
    expected,
  );
  expect(JSON.stringify(wire)).not.toContain('"message"');
});

test("the document boundary preserves unknown fields at every depth after validating known fields", () => {
  const value = {
    ...emptyLibraryState(),
    futureRoot: { enabled: true },
    repositories: [{ root: "/work/repo", enabled: [], futureRepository: { nested: [1, 2, 3] } }],
  };
  const decoded = Schema.decodeUnknownSync(LibraryStateDocument)(value);
  expect(decoded).toBe(value);
  const wire = Schema.encodeSync(Schema.fromJsonString(LibraryStateDocument))(decoded);
  expect(JSON.parse(wire)).toEqual(value);
});
