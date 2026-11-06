import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const plugin = join(import.meta.dirname, "oxlint-plugin-skit.mjs");
const oxlint = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

/** Exercise the real oxlint parser and plugin with a repository path and isolated config. */
async function lint(rule: string, source: string, path = "packages/cli/src/author/probe.ts") {
  const directory = await mkdtemp(join(tmpdir(), "skit-frontend-rules-"));
  const file = join(root, path.replace("probe", `lint-probe-${process.pid}-${Date.now()}`));
  const config = join(directory, ".oxlintrc.json");
  try {
    await writeFile(
      config,
      JSON.stringify({ jsPlugins: [plugin], rules: { [`skit/${rule}`]: "error" } }),
    );
    await writeFile(file, source);
    const result = spawnSync(
      process.execPath,
      [oxlint, "--config", config, "--format=json", file],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      diagnostics: Array<{ code: string; labels: Array<{ span: { line: number } }> }>;
    };
    expect(report.diagnostics.filter((item) => !item.code)).toEqual([]);
    return report.diagnostics
      .filter((item) => item.code.includes(rule))
      .map((item) => item.labels[0]?.span.line);
  } finally {
    await rm(file, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

describe("skit/frontend-no-resources", () => {
  test("checks aliases, direct imports, resource types and dynamic Node imports", async () => {
    expect(
      await lint(
        "frontend-no-resources",
        `
import { FileSystem as Fs, Effect as Fx, Scope as Lifetime } from "effect";
import * as Files from "effect/FileSystem";
import { acquireRelease as lease } from "effect/Effect";
import { ChildProcessSpawner as Spawner } from "effect/process";
import { randomUUID } from "node:crypto";
const a = Fx.gen(function* () { yield* Fs.FileSystem; yield* Files.FileSystem; });
const b = Fx.acquireRelease(open, close);
const c = lease(open, close);
type R = Fx.fn.Return<void, never, Lifetime.Scope>;
const d = import("node:fs/promises");
type F = Fs.FileSystem;
`,
      ),
    ).toEqual([5, 6, 7, 7, 8, 9, 10, 11, 12]);
  });

  test("leaves pure composition and owner/terminal resource access alone", async () => {
    const source = `import { Effect, FileSystem } from "effect";
const a = Effect.acquireRelease(open, close); const b = FileSystem.FileSystem;`;
    for (const path of [
      "packages/cli/src/registry/probe.ts",
      "packages/cli/src/terminal/probe.ts",
      "packages/skit/src/author/probe.ts",
    ])
      expect(await lint("frontend-no-resources", source, path)).toEqual([]);
    expect(
      await lint(
        "frontend-no-resources",
        `
import { Effect, Scope } from "effect";
import { join } from "node:path";
const resource = { acquireRelease() {} };
type A = Scope.Scope;
const a = Effect.gen(function* () { return yield* operation(); });
`,
      ),
    ).toEqual([]);
  });
});

describe("skit/frontend-one-owner-call", () => {
  test("does not count pure labels passed to a renderer as owner operations", async () => {
    expect(
      await lint(
        "frontend-one-owner-call",
        `
import { Effect } from "effect";
import { initSkit, skitLocator } from "@smolai/skit-core/author";
const a = Effect.gen(function* () {
  yield* renderer.note(skitLocator(remote));
  yield* initSkit(".");
});
`,
      ),
    ).toEqual([]);
  }, 30_000);
  test("counts aliased and namespace owner calls through status/pipe wrappers", async () => {
    expect(
      await lint(
        "frontend-one-owner-call",
        `
import { Effect as Fx } from "effect";
import { initSkit as init, readAuthorWorkspace } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library/session";
const a = Fx.fn("a")(function* () {
  yield* init(".").pipe(Fx.tap(render));
  yield* renderer.withStatus("Read", readAuthorWorkspace("."));
});
const b = Fx.gen(function* () {
  yield* Library.openLibrarySession(options);
  yield* Library.updateSources(options);
});
`,
      ),
    ).toEqual([5, 9]);
  });

  test("checks nested bodies independently and ignores callbacks and other APIs", async () => {
    expect(
      await lint(
        "frontend-one-owner-call",
        `
import { Effect } from "effect";
import { initSkit as init } from "@smolai/skit-core/author";
const a = Effect.gen(function* () {
  yield* renderer.note("Start");
  yield* init(".").pipe(Effect.tap(() => init("other")));
  yield* Effect.gen(function* () { yield* init("nested"); });
});
`,
      ),
    ).toEqual([]);
    expect(
      await lint(
        "frontend-one-owner-call",
        `
import { Effect } from "effect";
import { initSkit } from "@smolai/skit-core/author";
const a = Effect.gen(function* () { yield* initSkit("."); yield* initSkit("."); });
`,
        "packages/cli/src/registry/probe.ts",
      ),
    ).toEqual([]);
  });
});

describe("skit/command-module-exports", () => {
  test("recognizes command values returned by a local factory", async () => {
    expect(
      await lint(
        "command-module-exports",
        `
import { Command } from "effect/cli";
const build = () => Command.make("x", {}, handler);
export const command = build();
export const helper = () => {};
`,
      ),
    ).toEqual([5]);
  }, 30_000);
  test("rejects helpers, types and re-exports beside an aliased command", async () => {
    expect(
      await lint(
        "command-module-exports",
        `
import { Command as Cmd } from "effect/cli";
export const command = Cmd.make("x", {}, handler).pipe(Cmd.withDescription("x"));
export function helper() {}
export interface Options { home: string }
export { elsewhere } from "./elsewhere.js";
export * from "./types.js";
`,
      ),
    ).toEqual([4, 5, 6, 7]);
  });

  test("recognizes local command aliases, default exports and a second command", async () => {
    expect(
      await lint(
        "command-module-exports",
        `
import * as Cli from "effect/cli";
const command = Cli.Command.make("x", {}, handler);
export { command as cliCommand };
export const second = Cli.Command.make("y", {}, handler);
`,
      ),
    ).toEqual([5]);
    expect(
      await lint(
        "command-module-exports",
        `
import { Command } from "effect/cli";
const command = Command.make("x", {}, handler);
export default command;
const privateHelper = () => {};
`,
      ),
    ).toEqual([]);
    expect(
      await lint(
        "command-module-exports",
        `
import { Command } from "effect/cli";
export const factory = () => Command.make("x", {}, handler);
export const helper = () => {};
`,
      ),
    ).toEqual([]);
  });
});

describe("skit/no-failure-unions", () => {
  test("resolves imported tagged errors and local aliases, including later exports", async () => {
    expect(
      await lint(
        "no-failure-unions",
        `
import { AuthenticationRequired as Auth, RegistryUnreachable } from "../registry/failures.js";
type Alias = Auth;
export type Failures = Alias | RegistryUnreachable;
type Later = Auth | RegistryUnreachable;
export type { Later };
export type Domain = { _tag: "A" } | { _tag: "B" };
export type Mixed = Auth | string;
`,
      ),
    ).toEqual([4, 5]);
  }, 30_000);

  test("rejects explicit fn.Return failure unions but keeps single errors and domain unions", async () => {
    expect(
      await lint(
        "no-failure-unions",
        `
import { Effect as Fx } from "effect";
import { AuthenticationRequired as Auth, RegistryUnreachable } from "../registry/failures.js";
const a = Fx.fn("a")(function* (): Fx.fn.Return<void, Auth | RegistryUnreachable> { yield* run(); });
const b = Fx.fn("b")(function* (): Fx.fn.Return<string | undefined, Auth> { yield* run(); });
type Local = Auth | RegistryUnreachable;
const c = Fx.fn("c")(function* (): Fx.fn.Return<void, Local> { yield* run(); });
`,
      ),
    ).toEqual([4, 7]);
  }, 30_000);

  test("supports Effect submodule namespaces and ignores unrelated Return types", async () => {
    expect(
      await lint(
        "no-failure-unions",
        `
import * as Fx from "effect/Effect";
import { AuthenticationRequired as Auth, RegistryUnreachable } from "../registry/failures.js";
const a = Fx.fn("a")(function* (): Fx.fn.Return<void, Auth | RegistryUnreachable> { yield* run(); });
declare namespace Other { namespace fn { type Return<A, E> = A; } }
type Domain = Other.fn.Return<void, "one" | "two">;
export type Shape = { _tag: "A", message: string } | { _tag: "B", message: string };
`,
      ),
    ).toEqual([4]);
  }, 30_000);
});
