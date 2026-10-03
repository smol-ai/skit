import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { skitLayer } from "@smolai/skit-core";
import { devices, untouched } from "./helpers/library-sync-devices.js";

it.effect("characterizes local_bytes_changed as a stopped sync with exit 0", () =>
  Effect.gen(function* () {
    const { a } = yield* devices;
    yield* a.retain("local");
    yield* a.corruptOriginal;
    const unchanged = yield* untouched(a);
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
    yield* unchanged;
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
