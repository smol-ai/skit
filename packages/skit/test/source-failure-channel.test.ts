// What source acquisition is allowed to fail with.
//
// The resolver declared a catch-all `SkitError` alongside its named failures, and two of its
// adapters converted anything they caught into an ordinary failure: the source classifier ended
// `return new UnsafeSourceUrl()`, and the direct-document guard caught everything as
// `DirectSkillDocumentInvalid`. A programming mistake inside either was therefore reported as a
// bad source and given a semantic exit code.
//
// Each rejection those adapters can actually make is now thrown deliberately, so anything else is
// a defect and stays one. The `SkitError` member was vestigial -- nothing on the path constructed
// one -- and is gone.

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { join } from "node:path";
import { parseSkitSourceEffect, resolveSkitSourceEffect } from "../src/acquisition/sources.js";
import { skitLayer } from "../src/platform/layer.js";

const outcome = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "Success";
  const [first] = exit.cause.reasons;
  if (Cause.isDieReason(first)) return `Die(${(first.defect as Error)?.constructor?.name})`;
  return Cause.isFailReason(first) ? String((first.error as { _tag?: string })._tag) : "Interrupt";
};

const parse = (input: string, cwd?: string) =>
  Effect.exit(parseSkitSourceEffect(input, cwd)).pipe(Effect.provide(skitLayer));

describe("the source failure channel", () => {
  it.effect.each([
    ["", "SourceRequired"],
    ["/nonexistent/skit-source-channel", "SourceNotFound"],
    ["https://", "UnsafeSourceUrl"],
    ["https://user:pw@example.com/thing", "InsecureSourceUrl"],
    ["https://example.com/a b.git", "UnsafeSourceUrl"],
  ] as const)("classifies %s as %s", ([input, tag]) =>
    Effect.gen(function* () {
      // `https://` used to reach the catch-all as a TypeError from the URL constructor; it is a
      // named rejection now, and its exit-64 classification is unchanged.
      assert.strictEqual(outcome(yield* parse(input)), tag);
    }),
  );

  it.effect("lets a caller's own mistake stay a defect", () =>
    Effect.gen(function* () {
      // A non-string cwd is a bug in the caller, not a bad source. It reaches `path.resolve`
      // inside the classifier, which throws ERR_INVALID_ARG_TYPE. That used to be reported as
      // `UnsafeSourceUrl` with exit 64, indistinguishable from a user typing a bad URL.
      const exit = yield* parse("./somewhere", 7 as unknown as string);
      assert.strictEqual(outcome(exit), "Die(TypeError)");
    }),
  );

  it.effect("still rejects a downloaded document that is not a Skill", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("not a skill", {
              headers: { "content-type": "text/markdown" },
            }),
          ),
        ),
      );
      const exit = yield* Effect.exit(
        Effect.scoped(resolveSkitSourceEffect("https://example.com/skills/x/SKILL.md")),
      ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.provide(skitLayer));
      assert.strictEqual(outcome(exit), "DirectSkillDocumentInvalid");
    }),
  );

  it.effect("resolves a local directory without touching the classifier's failure paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-channel-" });
      const skill = join(root, "review");
      yield* fs.makeDirectory(skill, { recursive: true });
      yield* fs.writeFileString(
        join(skill, "SKILL.md"),
        "---\nname: review\ndescription: Review code carefully.\n---\n\n# Review\n",
      );
      const exit = yield* Effect.exit(parseSkitSourceEffect(skill));
      assert.strictEqual(outcome(exit), "Success");
    }).pipe(Effect.provide(skitLayer)),
  );
});
