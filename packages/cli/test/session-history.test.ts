import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHashEffect,
  LibraryActor,
  LibraryAuditLog,
  skitLayer,
} from "@smolai/skit-core";
import {
  confirmLibraryChange,
  openLibrarySession,
  proposeLibraryEnable,
} from "../src/workflows/library/session.js";
import {
  initializeLibraryMachine,
  libraryHome,
  retainObservedIn,
  writingTo,
} from "./helpers/library-home.js";

// The TUI and the interactive list confirm Binding changes through the Library session, with no
// command handler above them. Their history must not depend on one.
it.effect("a front end that confirms a Library session change leaves attributed history", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-session-history-" });
    const home = yield* libraryHome({ home: join(root, "home") });
    yield* initializeLibraryMachine(home.home);
    const installed = join(root, "installed", "review");
    yield* fs.makeDirectory(installed, { recursive: true });
    yield* fs.writeFileString(join(installed, "SKILL.md"), "local Skill\n");
    yield* home.owned(
      writingTo(
        home.home,
        retainObservedIn(home.home)({
          source: { type: "local", locator: installed },
          input: installed,
          retainedAt: "2026-09-17T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: installed,
              relativePath: ".",
              observedHash: yield* deterministicTreeHashEffect(installed),
            },
          ],
          observations: [],
        }),
      ),
    );
    const history = home.owned(Effect.flatMap(LibraryAuditLog, (audit) => audit.list()));
    const retainedEvents = (yield* history).length;

    const session = yield* home.owned(openLibrarySession(["codex"]));
    const proposed = yield* home.owned(
      proposeLibraryEnable(session, home.bindings, session.skills[0]!, {
        harnesses: ["codex"],
        scope: { kind: "global" },
      }),
    );
    const confirmed = yield* home
      .owned(confirmLibraryChange(proposed, home.bindings))
      .pipe(Effect.provideService(LibraryActor, "tui"));
    assert.notStrictEqual(confirmed.outcome?.kind, "failed");

    const events = yield* history;
    assert.strictEqual(events.length, retainedEvents + 1);
    const event = events.at(-1);
    assert.strictEqual(event?.type, "binding.enabled");
    assert.strictEqual(event?.workflow, "tui");
    assert.ok(
      event?.changes.some((change) => change.entity === "binding" && change.action === "enabled"),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
