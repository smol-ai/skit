import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { skitLayer } from "@smolai/skit-core";
import { setupCommand } from "../src/handlers/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { runSetup } from "../src/workflows/library/setup.js";
import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

it.effect("preserves saved v1 discovery roots when plain setup imports a Collection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-discovery-roots-repro-");
    const installed = join(root, ".agents", "skills", "review");
    const state = join(root, "state", "skills");
    const savedRoot = join(root, "saved-projects");
    const text = "---\nname: review\ndescription: Review code.\n---\n\n# Review\n";
    yield* fs.makeDirectory(installed, { recursive: true });
    yield* fs.makeDirectory(state, { recursive: true });
    yield* fs.writeFileString(join(installed, "SKILL.md"), text);
    yield* fs.writeFileString(
      join(state, ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          review: {
            source: "wellknown/skills.example",
            sourceType: "well-known",
            sourceUrl: "https://skills.example/review/SKILL.md",
            sourceBaseUrl: "https://skills.example",
            wellKnownDigest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
          },
        },
      }),
    );
    const home = yield* libraryHome({ home: join(root, "home"), inventoryHome: root });
    const machinePath = join(home.home, "machine.json");
    yield* fs.writeFileString(
      machinePath,
      JSON.stringify({ schemaVersion: 1, repositoryRoots: [savedRoot] }),
    );
    const options = {
      libraryHome: home.home,
      inventory: home.inventory,
      probePath: "",
      skillsStateHome: join(root, "state"),
    };
    const preview = yield* home.owned(
      runSetup({ ...options, repositoryRoots: [], persistRoots: false }),
    );
    const candidate = preview.onboarding.candidates.find(
      (item) => item.action === "import-observed-collection",
    );
    expect(candidate?.action).toBe("import-observed-collection");
    if (!candidate || candidate.action !== "import-observed-collection")
      throw new Error("Expected import candidate");
    expect(JSON.parse(yield* fs.readFileString(machinePath)).repositoryRoots).toEqual([savedRoot]);
    expect(preview.machineConfig.machineId).toBeUndefined();
    expect(preview.repositories).toEqual([]);
    const interaction = yield* makeScriptedInteraction([[candidate.groupKey], true, false]);
    yield* home.owned(
      writingTo(
        home.home,
        setupCommand({
          options,
          cwd: root,
          interactive: true,
          dryRun: false,
          localCustody: { acquisition: home.addOptions, bindings: home.bindings },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );
    expect((yield* home.durable).collections).toHaveLength(1);
    const persisted = JSON.parse(yield* fs.readFileString(machinePath));
    expect(persisted.machineId).toBeDefined();
    expect(persisted.discoveryRoots).toEqual([savedRoot]);
  }).pipe(Effect.provide(skitLayer)),
);
