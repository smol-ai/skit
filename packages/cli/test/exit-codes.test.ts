import { failureExitCode } from "../src/commands/exit-code.js";
// Domain failures retain their codes; numeric process statuses are chosen at the output boundary.

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { it } from "@effect/vitest";
import { describe, expect, test } from "vitest";
import { inspectSource } from "@smolai/skit-core/library/source";
import { HarnessMetadataInvalid } from "@smolai/skit-core/harnesses";
import { skitLayer } from "@smolai/skit-core/platform";
import { productionUrlTestClient } from "./helpers/http-test-client.js";
import { cliLayer } from "../src/application.js";
import { commandDescriptions } from "../src/commands/manifest.js";
import { skitCommand } from "../src/commands/tree.js";
import { classifyFailure, commandFailure } from "../src/commands/failure-classification.js";
import * as Library from "@smolai/skit-core/library";
import { NoStoredCredentials, RegistryUnreachable } from "../src/registry/failures.js";
import { LibraryDataFailure } from "../src/library/failures.js";

test("Library failure facts get CLI words and keep their exit codes after decoding", () => {
  const examples = [
    {
      failure: new Library.ContentAddressCollision(),
      message: "Canonical library content-address collision",
      remediation: "Run `skit doctor` to inspect the Library before retrying.",
      exitCode: 1,
    },
    {
      failure: new Library.UnknownInstalledSkill({ query: "review" }),
      message: "Unknown installed skill: review",
      remediation: "Run `skit list` to find an installed Skill.",
      exitCode: 1,
    },
    {
      failure: new Library.SecurityFindingAbsent({ fingerprint: "sha256:finding" }),
      message: "Finding is not present in the Skill Version: sha256:finding",
      remediation: "Run `skit security review <skill>` to list the findings in the Skill Version.",
      exitCode: 2,
    },
    {
      failure: new Library.LibraryChanged({ path: "/home/state.json" }),
      message: "The Library changed while this command ran; run it again: /home/state.json",
      remediation: "Run the command again.",
      exitCode: 1,
    },
  ];
  for (const { failure, message, remediation, exitCode } of examples) {
    const decoded = Schema.decodeUnknownSync(LibraryDataFailure)(
      JSON.parse(JSON.stringify(failure)),
    );
    expect(failureExitCode(failure.code)).toBe(exitCode);
    expect(classifyFailure(decoded)).toMatchObject({
      code: failure.code,
      message,
      remediation,
    });
  }
});

test.each([
  [
    "missing",
    "Principal and rationale are required",
    "Pass --principal and --rationale, then retry.",
  ],
  [
    "invalid-expiry",
    "expires-at must be a valid ISO instant",
    "Pass --expires-at as a future ISO instant, such as 2030-01-01T00:00:00Z.",
  ],
  [
    "expiry-in-past",
    "expires-at must be later than acceptance time",
    "Pass --expires-at as a future ISO instant, such as 2030-01-01T00:00:00Z.",
  ],
] as const)(
  "security acceptance %s has an actionable CLI failure",
  (reason, message, remediation) => {
    expect(classifyFailure(new Library.AcceptanceIncomplete({ reason }))).toMatchObject({
      code: "INVALID_ARGUMENT",
      message,
      remediation,
    });
  },
);

test("additional data-only failures are formatted as part of a command cause", () => {
  const failure = commandFailure(
    Cause.combine(
      Cause.fail(new Library.ContentAddressCollision()),
      Cause.fail(new Library.UnknownInstalledSkill({ query: "review" })),
    ),
  );
  expect(failureExitCode(failure.code)).toBe(1);
  expect(failure.message).toBe(
    "Canonical library content-address collision\nAdditional failure: Unknown installed skill: review",
  );
});

describe("command metadata", () => {
  // A missing effects annotation publishes `capabilities: []`, which reads as "no side effects".
  it.effect("every command declares the side effects it may have", () =>
    Effect.gen(function* () {
      const commands = yield* commandDescriptions(skitCommand);
      const undeclared = commands
        .filter((command) => command.effects.capabilities.length === 0)
        .map((command) => command.path.join(" "));
      expect(undeclared).toEqual([]);
    }).pipe(Effect.provide(cliLayer(false, "/tmp/skit-effects-test"))),
  );

  test("a named Registry failure keeps its code while the CLI owns the words", () => {
    expect(classifyFailure(new NoStoredCredentials())).toMatchObject({
      code: "NOT_FOUND",
      message: "No stored SKIT authentication to revoke",
      remediation: "Run `skit auth status` to see which Registries hold a stored credential.",
    });
    expect(
      classifyFailure(
        new RegistryUnreachable({
          origin: "https://registry.example",
          cause: new Error("offline"),
        }),
      ),
    ).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Unable to reach Registry https://registry.example\noffline",
      remediation: "Check the network connection and the Registry origin, then retry.",
    });
  });

  test("a source restoration failure gets its words from the CLI", () => {
    const failure = new Library.SourceRestoreInvalid({
      hash: `sha256:${"a".repeat(64)}`,
      reason: { _tag: "SourceImportMissing" },
    });
    expect(classifyFailure(failure)).toMatchObject({
      code: "OPERATION_FAILED",
      message: expect.stringContaining("has no exact Source Import"),
      remediation: expect.stringContaining("skit update"),
    });
  });

  test("a failure the owner describes in domain terms gets this executable's command", () => {
    const failure = new Library.InvalidLibraryState({
      path: "/home/state.json",
      reason: { _tag: "InvalidData" },
    });
    expect(classifyFailure(failure).remediation).toContain("skit setup");
    expect(classifyFailure(failure).message).toContain("/home/state.json");
  });

  test("anything not named as a failure ends the command with exit 1", () => {
    for (const value of [new Error("boom"), { code: "NOT_FOUND", message: "lookalike" }, "text"]) {
      const classified = classifyFailure(value);
      expect(classified).toMatchObject({ code: "OPERATION_FAILED" });
      expect(classified.remediation).not.toBe("");
    }
  });
});

test("a named validation failure uses its owner's remediation and exits 65", () => {
  const failure = new HarnessMetadataInvalid({
    path: "/skills/review/SKILL.md",
    kind: "SKILL.md frontmatter",
  });
  expect(classifyFailure(failure)).toMatchObject({
    code: "VALIDATION_FAILED",
    message: "Invalid SKILL.md frontmatter: /skills/review/SKILL.md",
    remediation: "Correct the YAML in /skills/review/SKILL.md, then retry.",
  });
  expect(classifyFailure(failure).remediation).not.toContain("skit author");
});

it.effect("malformed direct Skill downloads preserve the validation failure code", () =>
  Effect.gen(function* () {
    const routes = HttpRouter.serve(
      HttpRouter.addAll([
        HttpRouter.route<never, never>(
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
      inspectSource({
        source: { type: "url", url: "https://example.com/SKILL.md" },
        input: "https://example.com/SKILL.md",
      }).pipe(Effect.flip),
    ).pipe(Effect.provide(routes.pipe(Layer.provideMerge(client), Layer.provideMerge(skitLayer))));
    expect(classifyFailure(outcome)).toMatchObject({ code: "VALIDATION_FAILED" });
  }),
);
