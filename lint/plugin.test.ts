import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const pluginPath = join(import.meta.dirname, "oxlint-plugin-skit.mjs");

interface Diagnostic {
  code: string;
  line: number;
}

const allRules = [
  "no-record-any",
  "no-record-unknown",
  "no-run-skit",
  "no-nested-runtime",
  "no-promise-wrappers",
  "no-async-test-callback",
  "no-throw-in-effect",
  "no-error-instanceof",
  "no-cast-parsed-json",
  "no-structural-object-probe",
  "no-handrolled-fetch-double",
  "no-node-fs",
  "no-member-access-on-yield",
];

/** Runs the plugin over one source file and returns its diagnostics, newest oxlint JSON format. */
async function lint(source: string): Promise<Diagnostic[]> {
  const directory = await mkdtemp(join(tmpdir(), "skit-lint-"));
  const file = join(directory, "sample.ts");
  await writeFile(file, source);
  await writeFile(
    join(directory, ".oxlintrc.json"),
    JSON.stringify({
      jsPlugins: [pluginPath],
      rules: Object.fromEntries(allRules.map((rule) => [`skit/${rule}`, "error"])),
    }),
  );
  const result = spawnSync(
    "npx",
    ["oxlint", "--config", join(directory, ".oxlintrc.json"), "--format=json", file],
    { encoding: "utf8", cwd: join(import.meta.dirname, "..") },
  );
  const report = JSON.parse(result.stdout) as {
    diagnostics: Array<{ code: string; labels: Array<{ span: { line: number } }> }>;
  };
  return report.diagnostics
    .filter((item) => item.code?.startsWith("skit(") === true)
    .map((item) => ({ code: item.code, line: item.labels[0]?.span.line ?? 0 }));
}

describe("skit/no-record-any and skit/no-record-unknown", () => {
  test("rejects open value types regardless of key type", async () => {
    expect(
      await lint(
        [
          "export type A = Record<string, any>;",
          "export type B = Record<number, any>;",
          "export type C = Record<PropertyKey, any>;",
          "export type D = Record<string, unknown>;",
          "export type E = Record<number, unknown>;",
          "export type F = Record<PropertyKey, unknown>;",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-record-any)", line: 1 },
      { code: "skit(no-record-any)", line: 2 },
      { code: "skit(no-record-any)", line: 3 },
      { code: "skit(no-record-unknown)", line: 4 },
      { code: "skit(no-record-unknown)", line: 5 },
      { code: "skit(no-record-unknown)", line: 6 },
    ]);
  });

  test("rejects nested and generic-argument positions", async () => {
    expect(
      await lint(
        [
          "export type A = Array<Record<string, any>>;",
          "export type B = Record<string, Record<string, unknown>>;",
          "export function c(value: Map<string, Record<string, any>>): void {}",
          "export type D = { nested: { deeper: Record<string, unknown> } };",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-record-any)", line: 1 },
      { code: "skit(no-record-unknown)", line: 2 },
      { code: "skit(no-record-any)", line: 3 },
      { code: "skit(no-record-unknown)", line: 4 },
    ]);
  });

  test("allows named boundary types and concrete value types", async () => {
    expect(
      await lint(
        [
          "export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;",
          "export interface JsonObject { [key: string]: JsonValue }",
          "export interface YamlMapping { [key: string]: unknown }",
          "export type Flags = Record<string, string>;",
          "export type Profiles = Record<string, YamlMapping>;",
          "export type Loose = Map<string, unknown>;",
          "export function read(value: unknown): JsonObject | null { return null; }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("skit/no-member-access-on-yield", () => {
  test("requires a name before member access", async () => {
    expect(
      await lint(
        [
          "declare const load: () => Generator<unknown, { entries: unknown[] }, unknown>;",
          "function* bad() { return (yield* load()).entries; }",
          "function* good() { const library = yield* load(); return library.entries; }",
        ].join("\n"),
      ),
    ).toEqual([{ code: "skit(no-member-access-on-yield)", line: 2 }]);
  });
});

describe("skit/no-nested-runtime", () => {
  test("rejects every runtime entry point, however it is spelled", async () => {
    expect(
      await lint(
        [
          "declare const runSkit: (e: unknown) => Promise<void>;",
          "declare const Effect: any;",
          "declare const program: unknown;",
          "export const a = runSkit(program);",
          "export const b = Effect.runPromise(program);",
          "export const c = Effect.runSync(program);",
          "export const d = Effect.runFork(program);",
          "export const e = Effect.runPromiseExit(program);",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-run-skit)", line: 4 },
      { code: "skit(no-nested-runtime)", line: 5 },
      { code: "skit(no-nested-runtime)", line: 6 },
      { code: "skit(no-nested-runtime)", line: 7 },
      { code: "skit(no-nested-runtime)", line: 8 },
    ]);
  });

  test("leaves composition and unrelated names alone", async () => {
    expect(
      await lint(
        [
          "declare const Effect: any;",
          "declare const program: unknown;",
          "export const a = Effect.runtime;",
          "export const b = Effect.map(program, (value: unknown) => value);",
          "export const c = { runPromise: 1 };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("skit/no-promise-wrappers", () => {
  test("rejects wrapping a Promise back into an Effect", async () => {
    expect(
      await lint(
        [
          "declare const Effect: any;",
          "declare const write: () => Promise<void>;",
          "export const a = Effect.promise(() => write());",
          "export const b = Effect.tryPromise({ try: () => write(), catch: (e: unknown) => e });",
          "export const c = Effect.succeed(1);",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-promise-wrappers)", line: 3 },
      { code: "skit(no-promise-wrappers)", line: 4 },
    ]);
  });
});

describe("skit/no-async-test-callback", () => {
  test("rejects async test callbacks in a migrated suite", async () => {
    expect(
      await lint(
        [
          "declare const it: any;",
          "declare const test: any;",
          "declare const work: () => Promise<void>;",
          "it('a', async () => { await work(); });",
          "test('b', async () => { await work(); });",
          "it.only('c', async function () { await work(); });",
          "it('d', () => { work(); });",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-async-test-callback)", line: 4 },
      { code: "skit(no-async-test-callback)", line: 5 },
      { code: "skit(no-async-test-callback)", line: 6 },
    ]);
  });

  test("rejects awaiting inside an Effect test", async () => {
    expect(
      await lint(
        [
          "declare const it: any;",
          "declare const work: () => Promise<void>;",
          "it.effect('a', async () => { await work(); });",
        ].join("\n"),
      ),
    ).toEqual([{ code: "skit(no-async-test-callback)", line: 3 }]);
  });

  test("allows awaiting inside a callback the test passes to a foreign API", async () => {
    // A fetch double or HTTP handler has to be async to satisfy the API it implements. Its awaits
    // belong to that callback, not to the test body, so the suite is still yielding.
    expect(
      await lint(
        [
          "declare const it: any;",
          "declare const serve: (handler: (r: Request) => Promise<Response>) => any;",
          "it.effect('a', () => Effect.gen(function* () {",
          "  const server = async (r: Request) => { const body = await r.json(); return body; };",
          "  yield* serve(server);",
          "}));",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("leaves an Effect test that yields alone", async () => {
    expect(
      await lint(
        [
          "declare const it: any;",
          "declare const Effect: any;",
          "declare const work: unknown;",
          "it.effect('a', () => Effect.gen(function* () { yield* work; }));",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("skit/no-throw-in-effect", () => {
  test("rejects throwing out of an Effect body", async () => {
    expect(
      await lint(
        [
          "declare const Effect: any;",
          "export const a = Effect.fn('a')(function* () { throw new Error('no'); });",
          "export const b = Effect.gen(function* () { throw new Error('no'); });",
          "export function c() { throw new Error('fine'); }",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-throw-in-effect)", line: 2 },
      { code: "skit(no-throw-in-effect)", line: 3 },
    ]);
  });
});

describe("skit/no-error-instanceof", () => {
  test("rejects branching on a failure's prototype", async () => {
    expect(
      await lint(
        [
          "declare const error: unknown;",
          "declare const value: unknown;",
          "class OwnershipMarkerDisagrees {}",
          "class ValidationFailed {}",
          "export const a = error instanceof OwnershipMarkerDisagrees;",
          "export const b = value instanceof ValidationFailed;",
          "export const c = value instanceof TypeError;",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-error-instanceof)", line: 5 },
      { code: "skit(no-error-instanceof)", line: 6 },
      { code: "skit(no-error-instanceof)", line: 7 },
    ]);
  });

  test("leaves unrelated prototype checks alone", async () => {
    expect(
      await lint(
        [
          "declare const input: unknown;",
          "export const a = input instanceof Request;",
          "export const b = input instanceof Uint8Array;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("skit/no-cast-parsed-json", () => {
  test("rejects asserting a type over parsed bytes", async () => {
    expect(
      await lint(
        [
          "interface State { a: number }",
          "declare const text: string;",
          "declare const response: { json: () => Promise<unknown> };",
          "export const a = JSON.parse(text) as State;",
          "export async function b() { return (await response.json()) as State; }",
          "export const c = JSON.parse(text) as unknown;",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-cast-parsed-json)", line: 4 },
      { code: "skit(no-cast-parsed-json)", line: 5 },
      { code: "skit(no-cast-parsed-json)", line: 6 },
    ]);
  });
});

describe("skit/no-structural-object-probe", () => {
  test("rejects literal field probes guarded by Predicate.isObject", async () => {
    expect(
      await lint(
        [
          "declare const Predicate: any;",
          "declare const value: unknown;",
          'export const a = Predicate.isObject(value) && "schemaVersion" in value;',
          'export const b = Predicate.isObject(value) && ("left" in value ||',
          '  "right" in value);',
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-structural-object-probe)", line: 3 },
      { code: "skit(no-structural-object-probe)", line: 4 },
      { code: "skit(no-structural-object-probe)", line: 5 },
    ]);
  });

  test("allows typed-union narrowing and guards for a different value", async () => {
    expect(
      await lint(
        [
          "declare const Predicate: any;",
          "declare const value: { left: string } | { right: number };",
          "declare const other: unknown;",
          'export const a = "left" in value ? value.left : value.right;',
          'export const b = Predicate.isObject(other) && "left" in value;',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("skit/no-handrolled-fetch-double", () => {
  test("rejects a hand-rolled fetch stub", async () => {
    expect(
      await lint(
        [
          "export const fetcher: typeof fetch = async () => new Response();",
          "declare function use(f: typeof fetch): void;",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-handrolled-fetch-double)", line: 1 },
      { code: "skit(no-handrolled-fetch-double)", line: 2 },
    ]);
  });
});

describe("skit/no-node-fs", () => {
  test("rejects filesystem imports that bypass the platform seam", async () => {
    expect(
      await lint(
        [
          'import { mkdir } from "node:fs/promises";',
          'import { createWriteStream } from "node:fs";',
          'import { join } from "node:path";',
          "export const a = [mkdir, createWriteStream, join];",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-node-fs)", line: 1 },
      { code: "skit(no-node-fs)", line: 2 },
    ]);
  });
});
