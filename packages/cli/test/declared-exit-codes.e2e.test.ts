// The exit codes command-manifest.json publishes, checked against the binary that produces them.
//
// Three commands under-declared what they could do. These reproduce each one, so a regression
// shows up as a wrong number rather than as a caller branching on a contract that was never true.

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
  return Schema.decodeUnknownSync(FailureDocument)(result.stderr).error;
}

const CommandManifest = Schema.fromJsonString(
  Schema.Struct({
    commands: Schema.Array(
      Schema.Struct({ path: Schema.Array(Schema.String), exitCodes: Schema.Array(Schema.Number) }),
    ),
  }),
);
const commandManifest = Schema.decodeUnknownSync(CommandManifest)(
  readFileSync(join(import.meta.dirname, "../contracts/command-manifest.json"), "utf8"),
);
const declaredFor = (...path: string[]) =>
  commandManifest.commands.find((command) => command.path.join("\0") === path.join("\0"))
    ?.exitCodes ?? [];

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

    expect(result.status).toBe(12);
    expect(failure(result).code).toBe("CONFLICT");
    expect(declaredFor("auth", "status")).toContain(12);
  });

  test("auth logout reports CONFLICT when credentials cannot be read", async () => {
    const result = run(["auth", "logout", "https://example.test"], {
      home: await unreadableCredentials(),
    });

    expect(result.status).toBe(12);
    expect(declaredFor("auth", "logout")).toContain(12);
  });

  test("pin reports VALIDATION_FAILED for a malformed Library state", async () => {
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

    const result = run(["pin", "nope", "--version", "1.0.0", "--json"], { home: directory });

    expect(result.status).toBe(65);
    expect(failure(result).code).toBe("VALIDATION_FAILED");
    expect(declaredFor("pin")).toContain(65);
  });

  // Naming these moved them off the shared exit 1. An unsafe source string is a rejected
  // argument, not an unexpected failure, and add declares 64.
  test.each([
    { label: "unsafe characters", source: "https://example.com/a b.zip" },
    { label: "embedded credentials", source: "https://user:pw@example.com/a.zip" },
  ])("add rejects a source with $label as INVALID_ARGUMENT", async ({ source }) => {
    const result = run(["add", source], { home: await home() });
    expect(result.status).toBe(64);
    expect(declaredFor("add")).toContain(64);
  });

  // A non-current schemaVersion is invalid state, not a compatibility case. It is reported as
  // a validation failure on the same declared code as any other unreadable ledger.
  test.each([
    { handler: "check", args: ["check"] },
    { handler: "enable", args: ["enable", "nope", "--for", "codex"] },
  ])("$handler reports VALIDATION_FAILED for a non-current ledger", async ({ handler, args }) => {
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

    expect(result.status).toBe(65);
    expect(failure(result).code).toBe("VALIDATION_FAILED");
    expect(declaredFor(handler)).toContain(65);
  });

  test("an unclassified failure is the undeclared shared exit 1", async () => {
    const directory = await home();
    await mkdir(join(directory, "state.json"));

    const result = run(["list"], { home: directory });

    // exitCodes documents semantic outcomes and excludes this, so 1 stays unlisted by design.
    expect(result.status).toBe(1);
    expect(declaredFor("list")).not.toContain(1);
  });
});
