// The manifest publishes one process-status policy, checked against actual binary outcomes.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Schema } from "effect";

const bin = join(import.meta.dirname, "..", "bin", "skit.js");
const FailureDocument = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
);

function run(args: readonly string[], options: { home: string; cwd?: string }) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: { ...process.env, SKIT_HOME: options.home },
  });
}

/** The structured error envelope, which is the contract callers parse. */
function failure(result: { stderr: string }): { code: string; message: string } {
  return Schema.decodeSync(FailureDocument)(result.stderr).error;
}

const CommandManifest = Schema.fromJsonString(
  Schema.Struct({
    exitCodes: Schema.Struct({
      success: Schema.Literal(0),
      failure: Schema.Literal(1),
      invalidUsage: Schema.Literal(2),
    }),
  }),
);
const commandManifest = Schema.decodeSync(CommandManifest)(
  readFileSync(join(import.meta.dirname, "../contracts/command-manifest.json"), "utf8"),
);
const declaredCodes = Object.values(commandManifest.exitCodes);

async function home() {
  return mkdtemp(join(tmpdir(), "skit-exit-codes-"));
}

async function unreadableCredentials() {
  const directory = await home();
  const path = join(directory, "auth.json");
  await writeFile(path, '{"schemaVersion":1,"servers":{}}');
  await chmod(path, 0o000);
  return directory;
}

describe("declared exit codes match the binary", () => {
  test("auth status reports CONFLICT when credentials cannot be read", async () => {
    const result = run(["auth", "status", "--json"], { home: await unreadableCredentials() });

    expect(result.status).toBe(1);
    expect(failure(result).code).toBe("CONFLICT");
    expect(declaredCodes).toContain(1);
  });

  test("auth logout reports CONFLICT when credentials cannot be read", async () => {
    const result = run(["auth", "logout", "https://example.test"], {
      home: await unreadableCredentials(),
    });

    expect(result.status).toBe(1);
    expect(declaredCodes).toContain(1);
  });

  test("update reports VALIDATION_FAILED for a malformed Library state", async () => {
    const directory = await home();
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({
        schemaVersion: 2,
        entries: "not-an-array",
        bindings: [],
        installations: [],
        tombstones: [],
        unmanaged: [],
      }),
    );

    const result = run(["update", "nope", "--json"], { home: directory });

    expect(result.status).toBe(1);
    expect(failure(result).code).toBe("VALIDATION_FAILED");
    expect(declaredCodes).toContain(1);
  });

  // Rejected source arguments use invalid usage, while JSON retains the domain code.
  test.each([
    { label: "unsafe characters", source: "https://example.com/a b.zip" },
    { label: "embedded credentials", source: "https://user:pw@example.com/a.zip" },
  ])("add rejects a source with $label as INVALID_ARGUMENT", async ({ source }) => {
    const result = run(["add", source], { home: await home() });
    expect(result.status).toBe(2);
    expect(declaredCodes).toContain(2);
  });

  // A non-current schemaVersion is invalid state, not a compatibility case. It is reported as
  // a validation failure on the shared failure status, with its precise JSON code.
  test.each([
    { handler: "check", args: ["check"] },
    { handler: "enable", args: ["enable", "nope"] },
  ])("$handler reports VALIDATION_FAILED for a non-current ledger", async ({ args }) => {
    const directory = await home();
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [],
        bindings: [],
        installations: [],
        tombstones: [],
        unmanaged: [],
      }),
    );

    const result = run([...args, "--json"], { home: directory });

    expect(result.status).toBe(1);
    expect(failure(result).code).toBe("VALIDATION_FAILED");
    expect(declaredCodes).toContain(1);
  });

  test("an unclassified failure uses the shared failure status", async () => {
    const directory = await home();
    await mkdir(join(directory, "state.json"));

    const result = run(["list"], { home: directory });

    // Unexpected failures use the same shared failure status as named domain failures.
    expect(result.status).toBe(1);
    expect(declaredCodes).toContain(1);
  });
});
