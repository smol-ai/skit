import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { assertDiskUnchanged, captureDisk } from "./helpers/disk-snapshot.js";
import { devices } from "./helpers/library-sync-devices.js";
import { testPlatformLayer } from "./helpers/platform.js";

it.effect("characterizes local_bytes_changed as a stopped sync with exit 0", () =>
  Effect.gen(function* () {
    const { a } = yield* devices;
    yield* a.retain("local");
    yield* a.corruptOriginal;
    const unchanged = yield* captureDisk(a.disk);
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../bin/skit.js"), "sync", "--apply", "--home", a.home, "--json"],
      {
        env: { ...process.env, SKIT_SERVER_URL: "http://127.0.0.1:1", SKIT_TOKEN: "test" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(JSON.parse(result.stdout).data.status, "local_bytes_changed");
    // BUG: local_bytes_changed must exit non-zero. Flip this characterization when fixed.
    assert.strictEqual(result.status, 0);
    yield* assertDiskUnchanged(unchanged);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("reports an already-synced Library with a blocked device selection as nonzero", () =>
  Effect.gen(function* () {
    const { a, b, fs, remote } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    yield* fs.makeDirectory(join(b.root, "first"), { recursive: true });
    yield* fs.writeFileString(join(b.root, "first", "SKILL.md"), "existing copy\n");
    assert.strictEqual(
      (yield* b.sync({ deviceSelection: { skills: ["first"], collections: [] } })).status,
      "enablement_incomplete",
    );
    const head = yield* remote;
    assert.ok(head);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ library: head }));
    });
    yield* Effect.acquireRelease(
      Effect.callback<void, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)));
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      }),
      () =>
        Effect.callback<void, Error>((resume) => {
          server.close((error) => resume(error ? Effect.fail(error) : Effect.void));
        }).pipe(Effect.orDie),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    yield* b.edit((state) => ({ ...state, sync_ancestry: { ...state.sync_ancestry!, origin } }));
    const output = yield* Effect.callback<{ code: number | null; stdout: string }, Error>(
      (resume) => {
        const child = spawn(
          process.execPath,
          [
            join(import.meta.dirname, "../bin/skit.js"),
            "sync",
            "--apply",
            "--home",
            b.home,
            "--codex-root",
            b.root,
            "--json",
          ],
          {
            env: { ...process.env, SKIT_SERVER_URL: origin, SKIT_TOKEN: "test" },
          },
        );
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.on("error", (error) => resume(Effect.fail(error)));
        child.on("close", (code) => resume(Effect.succeed({ code, stdout })));
      },
    );
    assert.strictEqual(output.code, 12);
    const result = JSON.parse(output.stdout).data;
    assert.strictEqual(result.status, "enablement_incomplete");
    assert.strictEqual(result.sync_status, "clean");
    assert.isTrue(
      result.enablement_issues.some((issue: string) => issue.includes(join(b.root, "first"))),
    );
    assert.strictEqual(
      yield* fs.readFileString(join(b.root, "first", "SKILL.md")),
      "existing copy\n",
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
