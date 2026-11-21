import { NodeRuntime } from "@effect/platform-node";
// Process protocol only; every operation comes from the compiled core.
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../../dist/library/library.js";
import * as MachineSettings from "../../dist/library/machine-settings.js";
import { LibraryWriter, writeLibrary } from "../../dist/library/store/library-store.js";
import { localImportRequest } from "../../dist/library/setup/local-import.js";
import { deterministicTreeHash } from "../../dist/artifact/skit.js";
import { readPathEvidence } from "../../dist/library/folder-evidence.js";
import { skitLayer } from "../../dist/platform/layer.js";

const root = process.argv[2] ?? "",
  point = process.argv[3] ?? "";
const home = join(root, "library"),
  source = join(root, "source"),
  skills = join(root, "skills"),
  copy = join(skills, "review");
const roots = { home: root, configHome: root, overrides: { codex: [skills] } };
const text = "---\nname: review\ndescription: Process fixture\n---\nOriginal user bytes.\n";
const program = Effect.gen(function* () {
  if (!root || !point) return yield* Effect.die("Missing process fixture arguments");
  const fs = yield* FileSystem.FileSystem;
  if (point === "init") {
    for (const folder of [source, copy]) {
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(join(folder, "SKILL.md"), text);
    }
    yield* MachineSettings.updateDiscovery(home, { discoveryRoots: [join(root, "before")] });
    const request = yield* localImportRequest(source, "2026-11-17T00:00:00.000Z");
    if (Option.isNone(request)) return yield* Effect.die("Missing process fixture source");
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      yield* library.import.collection(request.value);
    }).pipe(Effect.provide(Library.layer({ home, roots })));
    return;
  }
  const setup = Effect.gen(function* () {
    const library = yield* Library.Service;
    const snapshot = yield* library.read;
    if (snapshot._tag !== "Present") return yield* Effect.die("Missing seeded Library");
    const skill = snapshot.state.skills[0];
    if (!skill) return yield* Effect.die("Missing seeded Skill");
    const evidence = yield* readPathEvidence(copy);
    if (Option.isNone(evidence) || evidence.value._tag !== "Directory")
      return yield* Effect.die("Missing managed folder evidence");
    const result = yield* library.setup(
      [
        {
          _tag: "Manage",
          mode: "existing",
          routing: {
            active: ["agents"],
            destinations: [{ scope: { kind: "global" }, destination: "agents", root: skills }],
            readable: [{ scope: { kind: "global" }, harness: "codex", root: skills }],
          },
          selections: [
            {
              mode: "existing",
              name: "review",
              source: evidence.value,
              subjectId: skill.skill_id,
              currentHash: yield* deterministicTreeHash(copy),
              duplicates: Option.some("keep-both"),
              approvedSymlinks: [],
              approvedCopies: [],
            },
          ],
        },
      ],
      { base: snapshot, machineChoices: { discoveryRoots: [join(root, "after")] } },
    );
    if (result._tag !== "Done") return yield* Effect.die(result);
    yield* fs.writeFileString(join(root, "setup-id"), result.operationId);
  });
  if (point === "prepare") return yield* setup.pipe(Effect.provide(Library.layer({ home, roots })));
  let reached = false;
  const gate = (operationId: string) =>
    Effect.gen(function* () {
      reached = true;
      yield* Effect.sync(() =>
        process.stdout.write(JSON.stringify({ kind: "paused", point, operationId }) + "\n"),
      );
      return yield* Effect.never;
    });
  yield* Effect.gen(function* () {
    const library = yield* Library.Service;
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const paused = LibraryWriter.of({
          ...writer,
          saveOperation: (next, base, state) =>
            Effect.gen(function* () {
              yield* writer.saveOperation(next, base, state);
              if (point === "setup-progress" && state) {
                const saved = yield* library.read;
                if (saved._tag === "Present" && saved.state.enabled.length > 0)
                  return yield* gate(next.operationId);
              }
            }),
          settleOperation: (base, reason) =>
            Effect.gen(function* () {
              if (point === "setup-before" && base.setup && reason === undefined)
                return yield* gate(base.operationId);
              yield* writer.settleOperation(base, reason);
              if (point === "setup-after" && base.setup && reason === undefined)
                return yield* gate(base.operationId);
            }),
          saveUndo: (recorded, next, base) =>
            Effect.gen(function* () {
              if (point === "undo-before") return yield* gate(recorded.operationId);
              yield* writer.saveUndo(recorded, next, base, yield* writer.revision);
              if (point === "undo-after") return yield* gate(recorded.operationId);
            }),
        });
        const action = point.startsWith("undo-")
          ? Effect.gen(function* () {
              const operationId = yield* fs.readFileString(join(root, "setup-id"));
              const plan = yield* library.plan(
                { _tag: "Undo", operationId },
                { base: yield* library.read },
              );
              yield* library.apply({ _tag: "Apply", plan });
            })
          : setup;
        yield* action.pipe(Effect.provideService(LibraryWriter, paused));
      }),
    );
  }).pipe(Effect.provide(Library.layer({ home, roots })));
  if (!reached) return yield* Effect.die("Requested process checkpoint was not reached");
});
const keepAlive = setInterval(() => {}, 60_000);
NodeRuntime.runMain(
  program.pipe(
    Effect.provide(skitLayer),
    Effect.scoped,
    Effect.ensuring(Effect.sync(() => clearInterval(keepAlive))),
  ),
);
