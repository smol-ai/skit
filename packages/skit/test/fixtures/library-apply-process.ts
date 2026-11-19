import { NodeRuntime } from "@effect/platform-node";
// Pause real owner operations at durable boundaries; the parent sends SIGKILL.
import { Effect, FileSystem, Layer, Option } from "effect";
import { join } from "node:path";
import * as Library from "../../dist/library/library.js";
import { skitLayer } from "../../dist/platform/layer.js";
import { localImportRequest } from "../../dist/library/setup/local-import.js";
import { loadOperations } from "../../dist/library/store/library-store.js";
import { libraryManifestFromLocalState } from "../../dist/library/library-state.js";
import { reviewInstalledSkillChanges } from "../../dist/library/installed-skill-review.js";

const [root = "", mode = ""] = process.argv.slice(2);
const home = join(root, "library");
const source = join(root, "source");
const skills = join(root, "skills");
const installed = join(skills, "review");
const keepAlive = setInterval(() => {}, 60_000);
NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(source, { recursive: true });
    yield* fs.makeDirectory(skills);
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: Apply process fixture\n---\nOriginal\n",
    );
    const request = yield* localImportRequest(source, "2026-11-16T00:00:00.000Z");
    if (Option.isNone(request)) return yield* Effect.die("Missing source");
    const layer = Library.layer({
      home,
      roots: { home: root, configHome: root, overrides: { codex: [skills] } },
    });
    const seed = yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const imported = yield* library.import.collection(request.value);
      const skill = imported.skills[0];
      if (!skill) return yield* Effect.die("Missing imported Skill");
      const intent: Library.Intent = {
        _tag: "Enabled",
        changes: [
          {
            _tag: "Enable",
            subject: { _tag: "Skill", id: skill.skill_id },
            where: [{ kind: "global" }],
          },
        ],
      };
      if (mode === "remove" || mode === "remove-done" || mode === "setup")
        yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan(intent, { base: yield* library.read }),
        });
      const snapshot = yield* library.read;
      if (snapshot._tag !== "Present") return yield* Effect.die("Missing Library");
      return {
        imported,
        intent,
        manifest: yield* libraryManifestFromLocalState({
          ...snapshot.state,
          enabled: [{ skill: skill.skill_id }],
        }),
        archives: yield* library.content.pack(snapshot),
      };
    }).pipe(
      Effect.provide(
        mode === "sync"
          ? Library.layer({
              home: join(root, "seed"),
              roots: { home: root, configHome: root, overrides: {} },
            })
          : layer,
      ),
    );
    if (mode === "setup") {
      yield* fs.writeFileString(
        join(source, "SKILL.md"),
        "---\nname: review\ndescription: Apply process fixture\n---\nUpdated\n",
      );
      const changed = yield* localImportRequest(source, "2026-11-16T01:00:00.000Z");
      if (Option.isNone(changed)) return yield* Effect.die("Missing updated source");
      yield* Effect.flatMap(Library.Service, (library) =>
        library.import.collection(changed.value),
      ).pipe(Effect.provide(layer));
    }
    const gate = Effect.andThen(
      Effect.sync(() => process.stdout.write(JSON.stringify({ kind: "paused", mode }) + "\n")),
      Effect.never,
    );
    const paused: FileSystem.FileSystem = {
      ...fs,
      rename: (from, to) =>
        Effect.gen(function* () {
          yield* fs.rename(from, to);
          if (
            (mode === "remove" && from === installed && to.includes(".skit-backups")) ||
            (mode !== "remove" && mode !== "remove-done" && to === installed)
          )
            return yield* gate;
        }),
      readDirectory: (path) =>
        Effect.gen(function* () {
          if (mode === "remove-done" && path === join(root, ".skit-backups")) {
            const operations = yield* loadOperations(home).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.orDie,
            );
            if (
              operations.some(
                (operation) =>
                  operation._tag === "Pending" &&
                  operation.steps.some(
                    ({ step }) => step._tag === "Apply" && step.phase._tag === "Done",
                  ),
              )
            )
              return yield* gate;
          }
          return yield* fs.readDirectory(path);
        }),
    };
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const base = yield* library.read;
      if (mode === "sync") {
        const staged = yield* library.content.stage(seed.manifest, {
          localArchives: seed.archives,
          registry: { origin: "https://registry.fixture", token: Option.none() },
        });
        const plan = yield* library.plan(
          {
            _tag: "Sync",
            staged,
            acceptedBase: Option.none(),
            deviceSelection: Option.none(),
            pendingOrigin: Option.none(),
            remote: Option.some({ origin: "https://registry.fixture", libraryId: Option.none() }),
          },
          { base },
        );
        if (!Library.isRemoteSyncPlan(plan)) return yield* Effect.die("Missing remote plan");
        const ancestry = {
          origin: "https://registry.fixture",
          library_id: "library_fixture",
          revision_id: "revision_fixture",
          base_manifest: seed.manifest,
        };
        yield* library.apply({
          _tag: "ApplySynced",
          plan,
          receipt: {
            origin: ancestry.origin,
            libraryId: ancestry.library_id,
            revisionId: ancestry.revision_id,
            ancestry,
            manifestDigest: staged.manifestDigest,
          },
        });
      } else if (mode === "setup") {
        const plan = yield* library.plan({ _tag: "Update" }, { base });
        const changes = reviewInstalledSkillChanges(plan);
        yield* library.setup(
          [
            {
              _tag: "Update",
              routing: {
                active: ["agents"],
                destinations: [{ scope: { kind: "global" }, destination: "agents", root: skills }],
                readable: [{ scope: { kind: "global" }, harness: "codex", root: skills }],
              },
              importedAt: "2026-11-16T01:00:00.000Z",
              versionChoices: [],
              changes: changes.map((change) => ({
                ...change,
                installedSkillId: Option.fromUndefinedOr(change.installedSkillId),
                baselineHash: Option.fromUndefinedOr(change.baselineHash),
                currentHash: Option.fromUndefinedOr(change.currentHash),
                desiredHash: Option.fromUndefinedOr(change.desiredHash),
                desiredVersionId: Option.fromUndefinedOr(change.desiredVersionId),
              })),
            },
          ],
          { base },
        );
      } else {
        const intent: Library.Intent = mode.startsWith("remove")
          ? { _tag: "Remove", collectionId: seed.imported.collection.collection_id }
          : seed.intent;
        yield* library.apply({ _tag: "Apply", plan: yield* library.plan(intent, { base }) });
      }
    }).pipe(
      Effect.provide(layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, paused)))),
    );
  }).pipe(
    Effect.provide(skitLayer),
    Effect.scoped,
    Effect.ensuring(Effect.sync(() => clearInterval(keepAlive))),
  ),
);
