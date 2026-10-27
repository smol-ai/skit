// The catalog publishes exitCodes in command-manifest.json, so callers branch on them. Nothing
// checked that those numbers matched what the CLI can actually produce. These do.

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { it } from "@effect/vitest";
import { describe, expect, test } from "vitest";
import {
  DescriptorMalformed,
  DirectSkillDocumentInvalid,
  HarnessMetadataInvalid,
  InvalidLibraryState,
  NoSkitDescriptorFound,
  InstalledSkillFileMissing,
  ReadmeFrontmatterMissing,
  resolveSkitSourceEffect,
  skitLayer,
} from "@smolai/skit-core";
import { productionUrlTestClient } from "./helpers/http-test-client.js";
import { commandApplicationLayer } from "../src/application.js";
import { commandDescriptions } from "../src/commands/manifest.js";
import { skitCommand } from "../src/commands/tree.js";
import { classifyFailure, failureExitCodes } from "../src/failure-classification.js";
import { SourceRestoreInvalid } from "@smolai/skit-core";
import { NoStoredCredentials, RegistryUnreachable } from "../src/registry/failures.js";

const produced = new Set<number>(Object.values(failureExitCodes));

/** Success, and the policy-blocked outcome a command reports through its result rather than a failure. */
const NON_FAILURE_CODES = new Set([0, 77]);

describe("declared exit codes", () => {
  it.effect("every declared failure code is one the table can produce", () =>
    Effect.gen(function* () {
      const commands = yield* commandDescriptions(skitCommand);
      const declared = new Set<number>(commands.flatMap((command) => command.successExitCodes));
      const unproducible = [...declared].filter(
        (code) => !NON_FAILURE_CODES.has(code) && !produced.has(code),
      );
      expect(unproducible).toEqual([]);
    }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-exit-codes-test"))),
  );

  it.effect("every exit status in the table is declared, including partial update failure", () =>
    Effect.gen(function* () {
      const commands = yield* commandDescriptions(skitCommand);
      const declared = new Set<number>(commands.flatMap((command) => command.successExitCodes));
      expect([...produced].filter((code) => !declared.has(code))).toEqual([]);
      // Exit 1 is also an intentional result for a partially failed update batch,
      // rather than only a shared unexpected failure.
      const update = commands.find((command) => command.path.join(" ") === "update");
      expect(update?.successExitCodes).toContain(1);
    }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-exit-taxonomy-test"))),
  );

  // The parser rejects an unknown flag or extra argument on any command before its handler runs.
  it.effect("every command declares the command-line rejection exit 64", () =>
    Effect.gen(function* () {
      const commands = yield* commandDescriptions(skitCommand);
      const undeclared = commands
        .filter((command) => !command.successExitCodes.includes(failureExitCodes.INVALID_ARGUMENT))
        .map((command) => command.path.join(" "));
      expect(undeclared).toEqual([]);
    }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-exit-parse-test"))),
  );

  // A missing effects annotation publishes `capabilities: []`, which reads as "no side effects".
  it.effect("every command declares the side effects it may have", () =>
    Effect.gen(function* () {
      const commands = yield* commandDescriptions(skitCommand);
      const undeclared = commands
        .filter((command) => command.effects.capabilities.length === 0)
        .map((command) => command.path.join(" "));
      expect(undeclared).toEqual([]);
    }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-effects-test"))),
  );

  test("a named failure classifies by its own code and remediation", () => {
    for (const failure of [
      new NoStoredCredentials(),
      new RegistryUnreachable({ origin: "https://registry.example", cause: new Error("offline") }),
      new SourceRestoreInvalid({
        digest: `sha256:${"a".repeat(64)}`,
        detail: "pinned Git acquisition has no commit",
      }),
    ])
      expect(classifyFailure(failure)).toEqual({
        code: failure.code,
        exitCode: failureExitCodes[failure.code],
        message: failure.message,
        remediation: failure.remediation,
      });
  });

  test("anything not named as a failure ends the command with exit 1", () => {
    for (const value of [new Error("boom"), { code: "NOT_FOUND", message: "lookalike" }, "text"]) {
      const classified = classifyFailure(value);
      expect(classified).toMatchObject({ code: "OPERATION_FAILED", exitCode: 1 });
      expect(classified.remediation).not.toBe("");
    }
  });
});

test("validation failures from shipped commands carry their own remediation", () => {
  for (const failure of [
    new ReadmeFrontmatterMissing(),
    new DescriptorMalformed({ format: "json", detail: "unexpected token" }),
    new DirectSkillDocumentInvalid(),
    new NoSkitDescriptorFound(),
    new InstalledSkillFileMissing({ path: "/skills/review/SKILL.md" }),
    new HarnessMetadataInvalid({ path: "/skills/review/SKILL.md", kind: "SKILL.md frontmatter" }),
    new InvalidLibraryState({ path: "/home/.skit/state.json", detail: "schema v2" }),
  ]) {
    expect(classifyFailure(failure)).toMatchObject({
      code: "VALIDATION_FAILED",
      exitCode: 65,
      remediation: failure.remediation,
    });
    expect(failure.remediation).not.toContain("skit author");
  }
});

it.effect("malformed direct Skill downloads preserve the validation exit code", () =>
  Effect.gen(function* () {
    const routes = HttpRouter.serve(
      HttpRouter.addAll([
        HttpRouter.route(
          "GET",
          "/SKILL.md",
          HttpServerResponse.text("not a skill", { contentType: "text/markdown" }),
        ),
      ]),
    );
    const client = productionUrlTestClient.pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
    );
    const outcome = yield* Effect.scoped(
      resolveSkitSourceEffect("https://example.com/SKILL.md").pipe(Effect.flip),
    ).pipe(Effect.provide(routes.pipe(Layer.provideMerge(client))), Effect.provide(skitLayer));
    expect(classifyFailure(outcome)).toMatchObject({ code: "VALIDATION_FAILED", exitCode: 65 });
  }),
);
