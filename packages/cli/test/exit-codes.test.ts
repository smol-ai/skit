// The catalog publishes exitCodes in command-manifest.json, so callers branch on them. Nothing
// checked that those numbers matched what the CLI can actually produce. These do.

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { it } from "@effect/vitest";
import { describe, expect, test } from "vitest";
import { resolveSkitSourceEffect, skitLayer } from "@smolai/skit-core";
import { productionUrlTestClient } from "./helpers/http-test-client.js";
import { commandApplicationLayer } from "../src/application.js";
import { commandDescriptions } from "../src/commands/manifest.js";
import { skitCommand } from "../src/commands/tree.js";
import { classifyFailure } from "../src/failure-classification.js";
import {
  Conflict,
  InvalidArgument,
  NotFound,
  OperationFailed,
  TargetCollision,
  ValidationFailed,
} from "../src/presentation/command-errors.js";

const taxonomy = [
  new NotFound({ message: "" }),
  new Conflict({ message: "" }),
  new InvalidArgument({ message: "" }),
  new ValidationFailed({ message: "" }),
  new TargetCollision({ message: "" }),
  new OperationFailed({ message: "" }),
];

/** Success, and the policy-blocked outcome a command reports through its result rather than a failure. */
const NON_FAILURE_CODES = new Set([0, 77]);

describe("declared exit codes", () => {
  it.effect("every declared failure code is one the taxonomy can produce", () =>
    Effect.gen(function* () {
      const produced = new Set<number>(taxonomy.map((error) => error.exitCode));
      const commands = yield* commandDescriptions(skitCommand);
      const declared = new Set<number>(commands.flatMap((command) => command.successExitCodes));
      const unproducible = [...declared].filter(
        (code) => !NON_FAILURE_CODES.has(code) && !produced.has(code),
      );
      expect(unproducible).toEqual([]);
    }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-exit-codes-test"))),
  );

  it.effect("every semantic taxonomy code is declared, and only the shared failure is not", () =>
    Effect.gen(function* () {
      const commands = yield* commandDescriptions(skitCommand);
      const declared = new Set<number>(commands.flatMap((command) => command.successExitCodes));
      const undeclared = taxonomy
        .filter((error) => !declared.has(error.exitCode))
        .map((error) => error.code);
      // Command metadata documents semantic outcomes callers may branch on and excludes shared
      // parse and unexpected failures. OPERATION_FAILED is that shared failure:
      // any command may exit 1, so declaring it per command would say nothing.
      expect(undeclared).toEqual(["OPERATION_FAILED"]);
    }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-exit-taxonomy-test"))),
  );

  test("each error carries a distinct code with remediation", () => {
    for (const error of taxonomy) {
      expect(error.remediation).not.toBe("");
      expect(error.exitCode).toBeGreaterThan(0);
    }
    expect(new Set(taxonomy.map((error) => error.code)).size).toBe(taxonomy.length);
  });
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
