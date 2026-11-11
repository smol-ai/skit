import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Data, Effect, FileSystem, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ZipFile } from "yazl";
import { skitLayer } from "../src/platform/layer.js";
import { SourceProcess } from "../src/platform/source-process.js";
import { resolveSkitSource } from "../src/sources/resolve.js";

const skill = "---\nname: review\ndescription: Review code.\n---\n# Review\n";

class ZipFixtureFailed extends Data.TaggedError("ZipFixtureFailed")<{ cause: unknown }> {
  override readonly message = "ZIP fixture failed";
}

const linkedZip = (outside: string) =>
  Effect.gen(function* () {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(outside), "escape", { mode: 0o120777 });
    zip.addBuffer(Buffer.from("must never escape"), "escape/escaped.txt");
    zip.addBuffer(Buffer.from(skill), "SKILL.md");
    zip.end();
    const chunks = yield* Stream.fromAsyncIterable(
      zip.outputStream,
      (cause) => new ZipFixtureFailed({ cause }),
    ).pipe(
      Stream.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
      Stream.runCollect,
    );
    return Buffer.concat(chunks);
  });

it.effect.each(["http", "registry", "discovery"] as const)(
  "%s rejects a link followed by a child entry before extracting, without escaping its temporary root",
  (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const process = yield* SourceProcess;
      const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "skit-archive-safety-" });
      const outside = join(sandbox, "outside");
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(join(outside, "existing.txt"), "unchanged");
      const bytes = yield* linkedZip(outside);
      const index = JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "review",
            description: "Review code.",
            type: "archive",
            url: "/review.zip",
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          },
        ],
      });
      let extractions = 0;
      const workspaces: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(request.url.endsWith("/index.json") ? index : bytes, {
              headers: { "skit-release-version": "1.0.0" },
            }),
          ),
        ),
      );
      const source =
        kind === "http"
          ? "https://archive.test/review.zip"
          : kind === "registry"
            ? "skit:tim/review@1.0.0"
            : "wellknown:https://archive.test";
      const failure = yield* Effect.scoped(
        resolveSkitSource(source, { registryBaseUrl: "https://archive.test" }),
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(SourceProcess, {
          ...process,
          run: (command, args, options) => {
            if (
              (command === "unzip" && args.includes("-q")) ||
              (command === "tar" && args.some((arg) => arg.startsWith("-x")))
            )
              extractions++;
            return process.run(command, args, options);
          },
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeTempDirectoryScoped: (options) =>
            fs.makeTempDirectoryScoped({ ...options, directory: sandbox }).pipe(
              Effect.tap((path) =>
                Effect.sync(() => {
                  workspaces.push(path);
                }),
              ),
            ),
        }),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "SourcePolicyViolation");
      if (failure._tag === "SourcePolicyViolation")
        assert.strictEqual(failure.reason._tag, "ArchiveLink");
      assert.strictEqual(extractions, 0);
      assert.strictEqual(yield* fs.exists(join(outside, "escaped.txt")), false);
      assert.strictEqual(yield* fs.readFileString(join(outside, "existing.txt")), "unchanged");
      assert.strictEqual(workspaces.length, 1);
      for (const workspace of workspaces) assert.strictEqual(yield* fs.exists(workspace), false);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each(["zip", "tar.gz", "tar"] as const)("still fetches a safe %s archive", (format) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-archive-safe-" });
    yield* fs.writeFileString(join(root, "SKILL.md"), skill);
    const bytes = yield* Effect.sync(() =>
      format === "zip"
        ? execFileSync("zip", ["-q", "-", "SKILL.md"], { cwd: root })
        : execFileSync("tar", [format === "tar.gz" ? "-czf" : "-cf", "-", "SKILL.md"], {
            cwd: root,
          }),
    );
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bytes))),
    );
    const resolved = yield* resolveSkitSource(`https://archive.test/review.${format}`).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.strictEqual(yield* fs.readFileString(join(resolved.originalRoot, "SKILL.md")), skill);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each(["tar", "tar.gz"] as const)(
  "rejects symbolic and hard links before %s extraction",
  (format) =>
    Effect.forEach(["symbolic", "hard"] as const, (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const process = yield* SourceProcess;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-tar-link-" });
        yield* fs.writeFileString(join(root, "SKILL.md"), skill);
        if (kind === "symbolic") yield* fs.symlink("SKILL.md", join(root, "link"));
        else yield* fs.link(join(root, "SKILL.md"), join(root, "link"));
        const bytes = yield* Effect.sync(() =>
          execFileSync("tar", [format === "tar.gz" ? "-czf" : "-cf", "-", "SKILL.md", "link"], {
            cwd: root,
          }),
        );
        let extractions = 0;
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bytes))),
        );
        const failure = yield* resolveSkitSource(`https://archive.test/review.${format}`).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(SourceProcess, {
            ...process,
            run: (command, args, options) => {
              if (command === "tar" && args.some((arg) => arg.startsWith("-x"))) extractions++;
              return process.run(command, args, options);
            },
          }),
          Effect.flip,
        );
        assert.strictEqual(failure._tag, "SourcePolicyViolation");
        if (failure._tag === "SourcePolicyViolation")
          assert.strictEqual(failure.reason._tag, "ArchiveLink");
        assert.strictEqual(extractions, 0);
      }),
    ).pipe(Effect.provide(skitLayer), Effect.scoped),
);
