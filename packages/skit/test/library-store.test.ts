import { PnpmSkillManaged } from "../src/installed-skills/pnpm-failures.js";
import { PluginManifestInvalid } from "../src/sources/plugin-failures.js";
import { DedicatedInstallerRequired } from "../src/sources/installer-guidance.js";
import { ImportRequestInvalid } from "../src/library/import-failures.js";
import {
  CollectionNotUpdatable,
  ReviewedChangeDiffers,
  GitInspectionFailed,
} from "../src/library/update-failures.js";
import {
  AuthorWorkspaceBusy,
  AuthorWorkspaceUnsafe,
  AuthorWorkspaceConflict,
  AuthorSyncStateInvalid,
  WorkspaceRoot,
} from "../src/author/workspace-contracts.js";
import { AuthorWorkspaceAlreadyRegistered, PublicationBlocked } from "../src/author/failures.js";
import { CollectionVersionArchiveInvalid } from "../src/library/snapshot-archive-universal.js";
import { SetEnabledIncomplete } from "../src/library/internal/session/set-enabled-contract.js";
import { InvocationUnavailable } from "../src/library/invocation-failure.js";
import { DescriptorMalformed } from "../src/artifact/failures.js";
import { HarnessMetadataInvalid } from "../src/harnesses/metadata-failures.js";
import {
  CollectionRemovalMissing,
  SkillRemovalRequiresCollection,
} from "../src/library/installation/remove.js";
import { openLibrary } from "./helpers/library-store.js";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Option, Predicate, Result, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { makeOperationId, migratedMachineId } from "../src/library/entity-ids.js";
import { collectionVersionPath } from "../src/library/collection-version.js";
import {
  emptyLibraryState,
  libraryManifestFromLocalState,
  type LibraryState,
} from "../src/library/library-state.js";
import { recordedLibrary } from "../src/library/internal/setup/intent.js";
import { readSnapshotArchive } from "../src/library/snapshot-archive.js";
import { OperationStatus, StepError } from "../src/library/store/state-schema.js";
import {
  ImportContentInvalid,
  AddNoSkills,
  SetupImportInvalid,
  LibrarySubjectNotFound,
  LibrarySubjectAmbiguous,
  SharedMappingInvalid,
  AcceptanceIncomplete,
  ContentAddressCollision,
  SecurityFindingAbsent,
  UnknownInstalledSkill,
  InvalidLibraryState,
  LibraryChanged,
  ManageSelectionInvalid,
  SetupStepsInvalid,
} from "../src/library/failures.js";
import { HomeBusy } from "../src/platform/lock-failures.js";
import { InvalidIntent, SetEnabledInvalid } from "../src/library/enabled-plan.js";
import { SyncConflicted } from "../src/library/internal/sync/conflict.js";
import { TreeError } from "../src/shared/tree-error.js";
import { RecoveryInvalid } from "../src/library/store/operation-failures.js";
import { InstalledSkillFailure } from "../src/installed-skills/files.js";
import { InstalledSkillInvalid } from "../src/library/installation/install-enabled.js";
import {
  StalePlan,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
  DestinationsIncomplete,
} from "../src/library/plan-failures.js";
import { Revision } from "../src/library/snapshot.js";
import { Changed } from "../src/library/installed-skill-facts.js";
import {
  UnsafeInstalledSkillName,
  UninstallConflict,
  UnsafeInstalledSkillBackups,
  SharedTargetCollision,
  InstalledPathCollision,
  SkillsDirectoryNotWritable,
  OwnershipMarkerDisagrees,
  InstalledSkillFileMissing,
} from "../src/installed-skills/failures.js";
import { badArgument, systemError } from "effect/PlatformError";

import {
  libraryOriginalsPath,
  LibraryWriter,
  loadLibrary,
  writeLibrary,
  type LibraryStateWriteError,
} from "../src/library/store/library-store.js";
import { Hash } from "../src/shared/hash.js";
import { skitLayer } from "../src/platform/layer.js";
import { lockFile } from "../src/platform/file-lock.js";

const machineId = migratedMachineId("019950c0-4c00-7000-8000-000000000001", "library-store-test");

const library = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-library-store-" });
  const home = join(workspace, "home");
  const source = join(workspace, "source");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(join(source, "SKILL.md"), "raw Skill bytes\n");
  yield* Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* openLibrary(home);
      return yield* owner.import.collection({
        machineId,
        source: { type: "local", path: source },
        input: source,
        importedAt: "2026-09-17T00:00:00.000Z",
        skills: [
          {
            name: "review",
            sourcePath: source,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(source),
          },
        ],
        lockFileEntries: [],
      });
    }),
  );
  /** Save `next` over `base` in a write of its own. */
  const save = (next: LibraryState, base: LibraryState) =>
    writeLibrary(
      home,
      Effect.flatMap(LibraryWriter, (writer) => writer.save(next, base)),
    );
  return { save, home, path: join(home, "state.json") };
});

it.effect("refuses to save a state its own loader would reject", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { save, home, path } = yield* library;
    const before = yield* fs.readFileString(path);
    const state = yield* loadLibrary(home);

    // Duplicate Collection IDs satisfy the state schema but not the portable manifest.
    const error = yield* save(
      { ...state, collections: [...state.collections, ...state.collections] },
      state,
    ).pipe(Effect.flip);

    assert.strictEqual(error._tag, "InvalidLibraryState");
    assert.strictEqual(yield* fs.readFileString(path), before);
    assert.deepStrictEqual(yield* loadLibrary(home), state);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("accepts exactly one of two writes planned from the same state", () =>
  Effect.gen(function* () {
    const { save, home } = yield* library;
    const base = yield* loadLibrary(home);
    const enabled = base.skills.map((skill) => ({ skill: skill.skill_id }));
    const global = { ...base, enabled };
    const local = { ...base, repositories: [{ root: "/workspace", enabled }] };

    const outcomes = yield* Effect.forEach(
      [global, local],
      (next) => Effect.result(save(next, base)),
      { concurrency: "unbounded" },
    );

    const winners = [global, local].filter((_, index) => Result.isSuccess(outcomes[index]!));
    const losers = outcomes.flatMap((outcome) =>
      Result.isFailure(outcome) ? [outcome.failure._tag] : [],
    );
    assert.strictEqual(winners.length, 1);
    assert.deepStrictEqual(losers, ["LibraryChanged"]);
    assert.deepStrictEqual(yield* loadLibrary(home), winners[0]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("accepts exactly one of two concurrent saves sharing one write", () =>
  Effect.gen(function* () {
    const { home } = yield* library;
    const base = yield* loadLibrary(home);
    const enabled = base.skills.map((skill) => ({ skill: skill.skill_id }));
    const global = { ...base, enabled };
    const local = { ...base, repositories: [{ root: "/workspace", enabled }] };

    // Both forks inherit the write's lock, so only the save mutex can serialize them.
    const outcomes = yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        return yield* Effect.forEach(
          [global, local],
          (next) => Effect.result(writer.save(next, base)),
          { concurrency: "unbounded" },
        );
      }),
    );

    const winners = [global, local].filter((_, index) => Result.isSuccess(outcomes[index]!));
    const losers = outcomes.flatMap((outcome) =>
      Result.isFailure(outcome) ? [outcome.failure._tag] : [],
    );
    assert.strictEqual(winners.length, 1);
    assert.deepStrictEqual(losers, ["LibraryChanged"]);
    assert.deepStrictEqual(yield* loadLibrary(home), winners[0]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses to save while another holder has the lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { save, home, path } = yield* library;
    const state = yield* loadLibrary(home);
    const before = yield* fs.readFileString(path);
    // Another holder, as another process would be.
    yield* lockFile(join(home, "lock.sqlite"));

    const error = yield* save({ ...state, enabled: [] }, state).pipe(Effect.flip);

    assert.strictEqual(error._tag, "HomeBusy");
    assert.strictEqual(yield* fs.readFileString(path), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("makes a save that outlives its write acquire the lock again", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { home, path } = yield* library;
    const base = yield* loadLibrary(home);
    const before = yield* fs.readFileString(path);
    const resume = yield* Deferred.make<void>();
    const child = yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        return yield* Deferred.await(resume).pipe(
          Effect.andThen(writer.save({ ...base, enabled: [] }, base)),
          Effect.forkDetach,
        );
      }),
    );
    // Another holder takes the lock once the write has released it.
    yield* lockFile(join(home, "lock.sqlite"));
    yield* Deferred.succeed(resume, undefined);

    assert.strictEqual((yield* Effect.flip(Fiber.join(child)))._tag, "HomeBusy");
    assert.strictEqual(yield* fs.readFileString(path), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.live("keeps the lock until a save already under way in a forked fiber has finished", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { home, path } = yield* library;
    const lock = join(home, "lock.sqlite");
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let armed = false;
    // Pause the save inside its check-and-write, at its read of the current state.
    const gatedFs: FileSystem.FileSystem = {
      ...fs,
      readFileString: (file, encoding) =>
        fs.readFileString(file, encoding).pipe(
          Effect.tap(() =>
            file === path && armed
              ? Effect.sync(() => {
                  armed = false;
                }).pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(resume)),
                )
              : Effect.void,
          ),
        ),
    };
    const base = yield* loadLibrary(home);
    const next = { ...base, enabled: [] };
    let child: Fiber.Fiber<void, LibraryStateWriteError> | undefined;
    const owner = yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        armed = true;
        child = yield* writer.save(next, base).pipe(Effect.forkDetach);
        yield* Deferred.await(entered);
      }),
    ).pipe(Effect.provideService(FileSystem.FileSystem, gatedFs), Effect.forkChild);

    yield* Deferred.await(entered);
    yield* Effect.sleep("50 millis");
    // The owner's program has returned, but its release waits for the save it lent the lock to.
    assert.isUndefined(owner.pollUnsafe());
    assert.isFalse(yield* Effect.isSuccess(Effect.scoped(lockFile(lock))));

    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(child!);
    yield* Fiber.join(owner);
    assert.isTrue(yield* Effect.isSuccess(Effect.scoped(lockFile(lock))));
    assert.deepStrictEqual(yield* loadLibrary(home), next);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/** What sync sends for a state: its portable manifest and the packed retained bytes. */
const synced = (state: LibraryState, originalsPath: string) =>
  Effect.all({
    manifest: libraryManifestFromLocalState(state),
    pack: Effect.forEach(state.collection_versions, (version) =>
      readSnapshotArchive(collectionVersionPath(originalsPath, version.hash)),
    ),
  });

it.effect("keeps operation records on this device: saved and loaded, never synced", () =>
  Effect.gen(function* () {
    const { save, home } = yield* library;
    const base = yield* loadLibrary(home);
    const hash = Hash.make(`sha256:${"a".repeat(64)}`);
    const parent = { path: join(home, "skills"), dev: 1n, ino: 2n };
    const folder = {
      _tag: "Directory" as const,
      path: join(home, "skills", "review"),
      dev: 1n,
      ino: 18446744073709551615n,
      parent,
      contentHash: hash,
      treeHash: hash,
      marker: Option.none(),
    };
    const removed = { _tag: "Absent" as const, path: folder.path, parent };
    const operations: OperationStatus[] = [
      OperationStatus.cases.Pending.make({
        operationId: makeOperationId(),
        steps: [
          {
            step: { _tag: "Remove", folders: [folder] },
            before: [folder],
            after: [removed],
            status: "Pending",
          },
        ],
        before: recordedLibrary(base),
      }),
      OperationStatus.cases.Stopped.make({
        operationId: makeOperationId(),
        steps: [],
        reason: {
          _tag: "EvidenceDiffers",
          step: 0,
          path: folder.path,
          expected: { before: Option.some(folder), after: Option.none() },
        },
        before: recordedLibrary(base),
        after: recordedLibrary(base),
      }),
      OperationStatus.cases.Done.make({
        operationId: makeOperationId(),
        steps: [],
        before: recordedLibrary(base),
        after: recordedLibrary(base),
      }),
    ];
    const next = {
      ...base,
      operations: yield* Schema.encodeEffect(Schema.Array(OperationStatus))(operations),
    };

    yield* save(next, base);
    const loaded = yield* loadLibrary(home);

    assert.deepStrictEqual(loaded, next);
    assert.deepStrictEqual(
      yield* Schema.decodeEffect(Schema.Array(OperationStatus))(loaded.operations),
      operations,
    );
    assert.deepStrictEqual(
      yield* synced(loaded, libraryOriginalsPath(home)),
      yield* synced(base, libraryOriginalsPath(home)),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a stopped operation keeps its step's error through state.json, in each stored form",
  () =>
    Effect.gen(function* () {
      const { save, home } = yield* library;
      const nativeSchemaError = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ requestId: Schema.String }),
      )({ requestId: 42 }).pipe(Effect.flip);
      const liveDescriptor = new DescriptorMalformed({
        format: "json",
        issue: { _tag: "Schema", failure: nativeSchemaError },
      });
      const storedDescriptor = new DescriptorMalformed({
        format: "json",
        issue: {
          _tag: "Schema",
          failure: {
            _tag: "StoredSchemaFailure",
            issues: [
              {
                path: ["requestId"],
                reason: { _tag: "InvalidType", expected: [{ type: "String" }] },
              },
            ],
          },
        },
      });
      const errors: readonly StepError[] = [
        liveDescriptor,
        new AuthorWorkspaceUnsafe({
          path: "/author/.skit/lock.sqlite",
          reason: {
            _tag: "LockFailed",
            cause: Object.assign(
              new Error("file is not a database", { cause: new Error("native context") }),
              { errcode: 26, code: "ERR_SQLITE_ERROR" },
            ),
          },
        }),
        new AuthorWorkspaceBusy({ root: WorkspaceRoot.make("/author") }),
        new AuthorSyncStateInvalid({
          path: "/author/.skit/connection.json",
          reason: { _tag: "MismatchedRemote", actual: "actual/tools", expected: "expected/tools" },
        }),
        new AuthorWorkspaceConflict({
          root: WorkspaceRoot.make("/author"),
          found: {
            root: WorkspaceRoot.make("/author"),
            identity: Option.none(),
            connection: { _tag: "Unconnected" },
          },
        }),
        new PublicationBlocked({
          reason: "content",
          diagnostics: [
            {
              code: "INVOCATION_METADATA_MISMATCH",
              severity: "error",
              path: "skills/review/SKILL.md",
              issue: {
                skill: "review",
                harness: "claude-code",
                path: "skills/review/SKILL.md",
                field: "disable-model-invocation",
                policy: "explicit",
                expected: "explicit",
              },
            },
          ],
        }),
        new AuthorWorkspaceAlreadyRegistered({ workspaceId: "workspace", at: "/author/original" }),
        new CollectionVersionArchiveInvalid({
          reason: {
            _tag: "HashMismatch",
            kind: "archive",
            expected: `sha256:${"a".repeat(64)}`,
            actual: `sha256:${"b".repeat(64)}`,
          },
        }),
        new DescriptorMalformed({
          format: "json",
          issue: {
            _tag: "Schema",
            failure: {
              _tag: "StoredSchemaFailure",
              issues: [
                {
                  path: ["skills", 0, "path"],
                  reason: {
                    _tag: "InvalidValue",
                    check: { id: "skit/schema/path-relative", payload: null },
                  },
                },
              ],
            },
          },
        }),
        new SetEnabledIncomplete({
          results: [],
          reason: "destinations",
          failure: new DestinationsIncomplete({ paths: ["/skills/review"] }),
        }),
        new InvocationUnavailable({
          failure: systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: "/source/review/SKILL.md",
          }),
        }),
        new DescriptorMalformed({ format: "json", issue: { _tag: "JsonSyntax", offset: 1 } }),
        new HarnessMetadataInvalid({
          path: "/skills/review/SKILL.md",
          kind: "SKILL.md frontmatter",
        }),
        new ImportContentInvalid({
          reason: { _tag: "ContentChanged", kind: "collection", skillName: "review" },
        }),
        new AddNoSkills({ source: "/sources/empty" }),
        new SetupImportInvalid({ skillName: "review", reason: "lock-changed" }),
        new LibrarySubjectNotFound({ query: "review" }),
        new LibrarySubjectAmbiguous({ query: "review" }),
        new SharedMappingInvalid({ target: "../escape" }),
        new CollectionRemovalMissing({ collection_id: "collection" }),
        new SkillRemovalRequiresCollection({ skill_id: "skill", collection_id: "collection" }),
        new StalePlan({
          reason: { _tag: "InstalledBytesChanged", kind: "reviewed", path: "/skills/review" },
          expected: Revision.make("present:reviewed"),
          actual: Revision.make("present:current"),
        }),
        new InstalledSkillWouldReplaceLink({ links: ["/skills/review"] }),
        new InstalledSkillWouldDuplicate({
          duplicates: [
            {
              name: "review",
              harness: "codex",
              canonicalPath: "/source/review",
              aliases: [{ path: "/skills/review", via: "directory" }],
              documentHash: "hash",
            },
          ],
        }),
        new DestinationsIncomplete({ paths: ["/skills/review"] }),
        new Changed({ path: "/skills/review" }),
        new RecoveryInvalid({
          reason: {
            _tag: "OperationStopped",
            operation: "Restore",
            operationId: "stopped-restore",
            reason: {
              _tag: "EvidenceDiffers",
              step: 1,
              path: "/skills/review",
              expected: {
                before: Option.some({
                  _tag: "Directory" as const,
                  path: "/skills/review",
                  dev: 1n,
                  ino: 9007199254740993n,
                  parent: { path: "/skills", dev: 1n, ino: 9007199254740995n },
                  contentHash: `sha256:${"a".repeat(64)}`,
                  treeHash: `sha256:${"b".repeat(64)}`,
                  marker: Option.none(),
                }),
                after: Option.none(),
              },
            },
          },
        }),
        new RecoveryInvalid({
          reason: {
            _tag: "OperationStopped",
            operation: "Undo",
            operationId: "stopped-undo",
            reason: {
              _tag: "StepFailed",
              step: 2,
              error: new RecoveryInvalid({
                reason: { _tag: "MissingRecord", record: "undo-file" },
              }),
            },
          },
        }),
        new InstalledSkillInvalid({ reason: { _tag: "InputsChanged", skillName: "review" } }),
        new UninstallConflict({ path: "/skills/review" }),
        new UnsafeInstalledSkillName({ skillName: "../outside" }),
        new UnsafeInstalledSkillBackups({ path: "/backup" }),
        new SharedTargetCollision({ target: "/skills" }),
        new InstalledPathCollision({ path: "/skills/review", kind: "file-or-directory" }),
        new SkillsDirectoryNotWritable({ root: "/skills" }),
        new OwnershipMarkerDisagrees({ skillId: "review", target: "/skills/review" }),
        new InstalledSkillFileMissing({ path: "/skills/review/SKILL.md" }),
        new TreeError({ reason: { _tag: "UnsupportedEntry", path: "/skills/review/socket" } }),
        new InstalledSkillFailure({
          reason: {
            _tag: "InvalidTree",
            reason: { _tag: "UnsupportedEntry", path: "/skills/review/socket" },
          },
        }),
        new RecoveryInvalid({
          reason: {
            _tag: "InvalidTree",
            reason: { _tag: "UnsupportedEntry", path: "/recovery/socket" },
          },
        }),
        new InvalidLibraryState({
          path: "/home/originals",
          reason: { _tag: "InvalidData", tree: { _tag: "InvalidSymlink", path: "review/link" } },
        }),
        new HomeBusy({ path: "/home/lock.sqlite" }),
        new LibraryChanged({ path: "/home/state.json" }),
        new AcceptanceIncomplete({ reason: "invalid-expiry" }),
        new ContentAddressCollision(),
        new SecurityFindingAbsent({ fingerprint: "sha256:finding" }),
        new UnknownInstalledSkill({ query: "review" }),
        new InvalidLibraryState({ path: "/home/state.json", reason: { _tag: "InvalidData" } }),
        systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "rename",
          description: "operation not permitted",
          syscall: "rename",
          pathOrDescriptor: "/skills/review",
        }),
        badArgument({ module: "FileSystem", method: "open", description: "bad flag" }),
        // Failures that carry data and no words keep their facts when stored.
        new SetEnabledInvalid({ reason: "selection-required" }),
        new InvalidIntent({ intent: "Sync" }),
        new ManageSelectionInvalid({ skillName: "review", reason: "machine-identity-missing" }),
        new SetupStepsInvalid({ reason: "path-in-library-storage", path: "/home/originals" }),
        new SyncConflicted({
          conflicts: [
            {
              _tag: "InstalledSkillChanged",
              key: "device:installed:modified-projection",
              resolution: "local",
              path: "/skills/review",
            },
          ],
        }),
        new PnpmSkillManaged({ path: "/skills/review", package: "a-package" }),
        new PluginManifestInvalid({
          path: "/source/plugin.json",
          reason: { _tag: "LinkEscape", root: "/source", target: "/outside" },
        }),
        new DedicatedInstallerRequired({
          sourceCoordinate: "github:pbakaus/impeccable",
          displayName: "Impeccable",
          command: "npx impeccable install",
          documentationUrl: "https://example.invalid/install",
        }),
        new ImportRequestInvalid({
          reason: { _tag: "DuplicateSkillName", name: "review", paths: ["a", "b"] },
        }),
        new CollectionNotUpdatable({ subject_id: "collection-review", label: "review" }),
        new ReviewedChangeDiffers({ path: "/skills/review" }),
        new GitInspectionFailed({
          operation: "cat-file",
          reason: { _tag: "ExitCode", exitCode: 128, stderr: "object missing" },
        }),
      ];
      const operations = errors.map((error, step) =>
        OperationStatus.cases.Stopped.make({
          operationId: makeOperationId(),
          steps: [],
          reason: { _tag: "StepFailed", step, error },
          before: recordedLibrary(emptyLibraryState()),
          after: recordedLibrary(emptyLibraryState()),
        }),
      );
      const base = yield* loadLibrary(home);
      yield* save(
        {
          ...base,
          operations: yield* Schema.encodeEffect(Schema.Array(OperationStatus))(operations),
        },
        base,
      );

      const loaded = yield* Schema.decodeEffect(Schema.Array(OperationStatus))(
        (yield* loadLibrary(home)).operations,
      );

      // Each error reads back as the same kind, with every stored field equal.
      const fields = (error: unknown) =>
        Predicate.isError(error)
          ? {
              kind: error.constructor.name,
              message: error.message,
              ...Object.fromEntries(Object.entries(error)),
            }
          : error;
      assert.deepStrictEqual(
        loaded.map((operation) =>
          operation._tag === "Stopped" && operation.reason._tag === "StepFailed"
            ? fields(operation.reason.error)
            : undefined,
        ),
        errors.map((error) => fields(error === liveDescriptor ? storedDescriptor : error)),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reads a recorded LibraryBusy failure without rewriting it, and encodes HomeBusy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-old-home-busy-" });
    const state = emptyLibraryState();
    const bytes = JSON.stringify({
      ...state,
      operations: [
        {
          _tag: "Stopped",
          operationId: makeOperationId(),
          steps: [],
          before: recordedLibrary(state),
          after: recordedLibrary(state),
          reason: {
            _tag: "StepFailed",
            step: 0,
            error: { _tag: "LibraryBusy", path: "/home/lock.sqlite" },
          },
        },
      ],
    });
    yield* fs.writeFileString(join(home, "state.json"), bytes);
    const owner = yield* openLibrary(home);
    const snapshot = yield* owner.read;
    assert.strictEqual(snapshot._tag, "Present");
    if (snapshot._tag !== "Present") return;
    const operations = yield* Schema.decodeEffect(Schema.Array(OperationStatus))(
      snapshot.state.operations,
    );
    const operation = operations[0];
    assert.strictEqual(operation?._tag, "Stopped");
    if (operation?._tag !== "Stopped" || operation.reason._tag !== "StepFailed")
      return yield* Effect.die("Missing stopped failure");
    assert.strictEqual(operation.reason.error._tag, "HomeBusy");
    assert.deepStrictEqual(yield* Schema.encodeEffect(StepError)(operation.reason.error), {
      _tag: "HomeBusy",
      path: "/home/lock.sqlite",
    });
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), bytes);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reads historical stored prose without rewriting bytes or inventing failure facts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-old-step-text-" });
    const state = emptyLibraryState();
    const bytes = JSON.stringify({
      ...state,
      operations: [
        {
          _tag: "Stopped",
          operationId: makeOperationId(),
          steps: [],
          before: recordedLibrary(state),
          after: recordedLibrary(state),
          reason: {
            _tag: "StepFailed",
            step: 0,
            error: {
              _tag: "HistoricalFailure",
              code: "CONFLICT",
              message: "historical diagnostic",
              remediation: "historical guidance",
            },
          },
        },
      ],
    });
    yield* fs.writeFileString(join(home, "state.json"), bytes);
    const snapshot = yield* (yield* openLibrary(home)).read;
    assert.strictEqual(snapshot._tag, "Present");
    if (snapshot._tag !== "Present") return;
    const operations = yield* Schema.decodeEffect(Schema.Array(OperationStatus))(
      snapshot.state.operations,
    );
    const operation = operations[0];
    if (operation?._tag !== "Stopped" || operation.reason._tag !== "StepFailed")
      return yield* Effect.die("Missing historical failure");
    assert.deepStrictEqual(yield* Schema.encodeEffect(StepError)(operation.reason.error), {
      _tag: "Library.LegacyStepFailure",
      failureTag: "HistoricalFailure",
      originalCode: "CONFLICT",
      diagnostic: "historical diagnostic",
      originalRemediation: "historical guidance",
    });
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), bytes);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
