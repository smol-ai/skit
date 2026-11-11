import { stringify } from "yaml";
import { prepareAuthored } from "../src/library/internal/content/prepare-authored.js";
import { walkTree } from "../src/artifact/tree.js";
import { readSkitDescriptor } from "../src/artifact/skit.js";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { skitLayer } from "../src/platform/layer.js";
import { validateSkitDirectory } from "../src/artifact/skit.js";
import { SkitValidationDiagnostic } from "../src/artifact/validation-diagnostic.js";
import { copySkitFixtureEffect } from "./helpers/skit-fixture.js";

it.effect(
  "example refusal facts retain parser locations, schema paths and reference identities",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-validation-facts-" });
      yield* copySkitFixtureEffect("authored", root);
      const example = (directory: string, body: string) =>
        Effect.gen(function* () {
          const path = join(root, "examples", "review", directory);
          yield* fs.makeDirectory(path, { recursive: true });
          yield* fs.writeFileString(join(path, "case.yaml"), body);
        });
      yield* example("syntax", "id: [\n");
      yield* example("shape", "id: wrong\n");
      yield* example(
        "references",
        JSON.stringify({
          schema_version: "skit.skill-example/v1",
          id: "unknown",
          skill: "absent",
          title: "Example",
          prompt: { path: "prompt.md", provenance: "synthetic" },
          execution: { isolation: "skill_only", network: "disabled", fixtures: ["fixture.txt"] },
          screenshots: [{ path: "image.txt", role: "output", alt: "Result" }],
          privacy: { classification: "public_safe", reviewed: true },
        }),
      );
      yield* fs.writeFileString(join(root, "examples/review/references/image.txt"), "not an image");
      const validated = yield* validateSkitDirectory(root, "unpublished", {
        assessmentContext: "import",
      });
      expect(validated.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "EXAMPLE_MANIFEST_INVALID",
            path: "examples/review/syntax/case.yaml",
            reason: {
              _tag: "Malformed",
              issue: expect.objectContaining({
                _tag: "YamlSyntax",
                errors: expect.arrayContaining([
                  expect.objectContaining({ code: "BAD_INDENT", line: 2 }),
                ]),
              }),
            },
          }),
          expect.objectContaining({
            code: "EXAMPLE_MANIFEST_INVALID",
            path: "examples/review/shape/case.yaml",
            reason: {
              _tag: "Malformed",
              issue: expect.objectContaining({
                _tag: "Schema",
                failure: expect.objectContaining({ _tag: "SchemaError" }),
              }),
            },
          }),
          expect.objectContaining({
            code: "EXAMPLE_PATH_IDENTITY_MISMATCH",
            skill: "absent",
            id: "unknown",
            directorySkill: "review",
            directoryId: "references",
          }),
          expect.objectContaining({ code: "EXAMPLE_SKILL_UNKNOWN", skill: "absent" }),
          expect.objectContaining({
            code: "EXAMPLE_PROMPT_MISSING",
            path: "examples/review/references/prompt.md",
          }),
          expect.objectContaining({
            code: "EXAMPLE_FIXTURE_MISSING",
            path: "examples/review/references/fixture.txt",
          }),
          expect.objectContaining({
            code: "EXAMPLE_SCREENSHOT_MEDIA_INVALID",
            mediaType: "text/plain; charset=utf-8",
          }),
        ]),
      );
      const codec = Schema.Array(SkitValidationDiagnostic);
      const wire = Schema.encodeSync(codec)(validated.diagnostics);
      const loaded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(wire)));
      expect(Schema.encodeSync(codec)(loaded)).toEqual(wire);
      for (const diagnostic of wire) expect(diagnostic).not.toHaveProperty("message");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("held Author inputs carry their validation facts without rebuilding warning prose", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-held-validation-" });
    yield* copySkitFixtureEffect("authored", root);
    const descriptor = yield* readSkitDescriptor(root);
    yield* fs.writeFileString(
      join(root, "README.md"),
      `---\n${stringify({ ...descriptor, capabilities: { hooks: ["missing-hook.sh"] } })}---\n`,
    );
    const tree = yield* walkTree(root, "normalized");
    const result = yield* prepareAuthored(
      root,
      tree.filter((entry) => entry.kind === "file"),
      {
        revisionId: "revision",
        savedAt: "2026-11-10T00:00:00Z",
        importedAt: "2026-11-10T00:00:00Z",
      },
      undefined,
      ["codex"],
    );
    expect(result.root).toBeUndefined();
    expect(result.issues).toEqual([
      {
        _tag: "ValidationHeld",
        skill: "review",
        diagnostics: [
          { code: "CAPABILITY_PATH_MISSING", severity: "error", path: "missing-hook.sh" },
        ],
      },
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
