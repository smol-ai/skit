import { assert, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { resolveSkitSource } from "../src/sources/resolve.js";
import { skitLayer } from "../src/platform/layer.js";

const skill = "---\nname: review\ndescription: Review code.\n---\n# Review\n";
const archive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-registry-archive-" });
  yield* fs.writeFileString(join(root, "SKILL.md"), skill);
  return yield* Effect.sync(() => execFileSync("zip", ["-q", "-", "SKILL.md"], { cwd: root }));
});

it.effect.each([
  { selected: "latest", reported: "1.2.3" },
  { selected: "1.2.3", reported: undefined },
])(
  "records the immutable version for $selected (header $reported) and keeps staging alive",
  ({ selected, reported }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bytes = yield* archive;
      let staged = "";
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            // MIME is not a direct-document override for Registry releases.
            new Response(bytes, {
              headers: {
                "content-type": "text/plain",
                ...(reported ? { "skit-release-version": reported } : {}),
              },
            }),
          ),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* resolveSkitSource(`skit:tim/review@${selected}`, {
            registryBaseUrl: "https://registry.test/",
          });
          assert.deepStrictEqual(resolved.revision, { kind: "release", version: "1.2.3" });
          assert.deepStrictEqual(resolved.source, {
            type: "registry",
            namespace: "tim",
            slug: "review",
            version: selected,
            authority: "https://registry.test",
          });
          staged = resolved.originalRoot;
          assert.strictEqual(yield* fs.readFileString(join(staged, "SKILL.md")), skill);
        }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      );
      assert.strictEqual(yield* fs.exists(staged), false);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each([
  { selected: "latest", reported: undefined },
  { selected: "latest", reported: "latest" },
  { selected: "latest", reported: "invalid" },
  { selected: "1.2.3", reported: "1.2.4" },
])(
  "rejects version disagreement before reading a body ($selected, $reported)",
  ({ selected, reported }) =>
    Effect.gen(function* () {
      let reads = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads++;
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, { headers: reported ? { "skit-release-version": reported } : {} }),
          ),
        ),
      );
      const failure = yield* resolveSkitSource(`skit:tim/review@${selected}`, {
        registryBaseUrl: "https://registry.test",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);
      assert.strictEqual(failure._tag, "SourcePolicyViolation");
      if (failure._tag === "SourcePolicyViolation")
        assert.strictEqual(failure.reason._tag, "VersionDisagreement");
      assert.strictEqual(reads, 0);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "Registry releases reject a direct Skill document while ordinary HTTP still accepts it",
  () =>
    Effect.gen(function* () {
      const failure = yield* resolveSkitSource("skit:tim/review", {
        registryBaseUrl: "https://registry.test",
      }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "SourcePolicyViolation");
      assert.include(failure.message, "must be a ZIP archive");
      const resolved = yield* resolveSkitSource("https://registry.test/review/SKILL.md");
      const fs = yield* FileSystem.FileSystem;
      assert.strictEqual(yield* fs.readFileString(join(resolved.originalRoot, "SKILL.md")), skill);
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(skill, {
                headers: { "content-type": "text/plain", "skit-release-version": "1.2.3" },
              }),
            ),
          ),
        ),
      ),
      Effect.provide(skitLayer),
      Effect.scoped,
    ),
);

it.effect("a canonical Registry source never receives another Registry's selected credential", () =>
  Effect.gen(function* () {
    const bytes = yield* archive;
    const seen: { url: string; authorization: string | undefined }[] = [];
    const client = HttpClient.make((request) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bytes)));
    });
    yield* resolveSkitSource("skit://canonical.test/tim/review@1.2.3", {
      registryBaseUrl: "https://other.test",
      registryToken: "other-token",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    assert.deepStrictEqual(seen, [
      {
        url: "https://canonical.test/api/skits/tim/review/releases/1.2.3/download",
        authorization: undefined,
      },
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
