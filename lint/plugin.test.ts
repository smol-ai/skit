import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { bannedForm, bannedVerbs } from "./term-rules.mjs";

const pluginPath = join(import.meta.dirname, "oxlint-plugin-skit.mjs");
// Invoke the installed CLI directly so fixtures do not pay npx's cold-start cost.
const oxlintPath = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

interface Diagnostic {
  code: string;
  line: number;
}

const allRules = [
  "no-middle-dot-delimiter",
  "banned-terms",
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
  "no-unconditional-cause-recovery",
];

/** Runs the plugin over one source file and returns its diagnostics, newest oxlint JSON format. */
async function lint(source: string, extension = "ts"): Promise<Diagnostic[]> {
  const directory = await mkdtemp(join(tmpdir(), "skit-lint-"));
  const file = join(directory, `sample.${extension}`);
  await writeFile(file, source);
  await writeFile(
    join(directory, ".oxlintrc.json"),
    JSON.stringify({
      plugins: ["typescript"],
      jsPlugins: [pluginPath],
      rules: {
        ...Object.fromEntries(allRules.map((rule) => [`skit/${rule}`, "error"])),
        "typescript/no-non-null-asserted-optional-chain": "error",
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [oxlintPath, "--config", join(directory, ".oxlintrc.json"), "--format=json", file],
    { encoding: "utf8", cwd: join(import.meta.dirname, "..") },
  );
  const report = JSON.parse(result.stdout) as {
    diagnostics: Array<{ code: string; labels: Array<{ span: { line: number } }> }>;
  };
  return report.diagnostics
    .filter(
      (item) =>
        item.code?.startsWith("skit(") === true ||
        item.code === "typescript(no-non-null-asserted-optional-chain)",
    )
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
  test("allows only a direct module import, including an aliased Effect namespace", async () => {
    expect(
      await lint(`
        import { Effect as Fx } from "effect";
        export const module = Fx.promise(() => import("@effect/sql-sqlite-node"));
        export const disguised = Fx.promise(() => import("driver").then(run));
        export const work = Fx["tryPromise"](() => write());
      `),
    ).toEqual([
      { code: "skit(no-promise-wrappers)", line: 4 },
      { code: "skit(no-promise-wrappers)", line: 5 },
    ]);
  });

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

describe("skit/no-unconditional-cause-recovery", () => {
  test("rejects logging or fallback success for the whole cause", async () => {
    expect(
      await lint(`
        import { Effect as Fx } from "effect";
        export const log = Fx.catchCause((cause) => Fx.logWarning("failed", cause));
        export const fallback = Fx["catchCause"](program, () => Fx.succeed([]));
        export const other = Fx.catchCause((cause) => Fx.failCause(unrelated));
      `),
    ).toEqual([
      { code: "skit(no-unconditional-cause-recovery)", line: 3 },
      { code: "skit(no-unconditional-cause-recovery)", line: 4 },
      { code: "skit(no-unconditional-cause-recovery)", line: 5 },
    ]);
  });

  test("allows explicit original-cause propagation and typed recovery", async () => {
    expect(
      await lint(`
        import * as Fx from "effect/Effect";
        export const reraised = Fx.catchCause((cause) =>
          Fx.logWarning("failed", cause).pipe(Fx.andThen(Fx.failCause(cause))));
        export const classified = Fx.catchCause(program, (cause) =>
          Cause.hasInterruptsOnly(cause) ? Fx.failCause(cause) : render(cause));
        export const recover = Fx.catch((error) => Fx.logWarning("pending", error));
      `),
    ).toEqual([]);
  });

  test("checks direct named imports and requires inspectable cause recovery", async () => {
    expect(
      await lint(`
        import { catchCause as recover, failCause as propagate } from "effect/Effect";
        export const good = recover((cause) => propagate(cause));
        export const bad = recover((cause) => log(cause));
        export const opaque = recover(handler);
      `),
    ).toEqual([
      { code: "skit(no-unconditional-cause-recovery)", line: 4 },
      { code: "skit(no-unconditional-cause-recovery)", line: 5 },
    ]);
  });
});

describe("typescript/no-non-null-asserted-optional-chain", () => {
  test("rejects asserting an optional result and allows explicit narrowing", async () => {
    expect(
      await lint(`
        declare const input: { value: string } | undefined;
        export const unsafe = input?.value!;
        export const safe = input === undefined ? undefined : input.value;
      `),
    ).toEqual([{ code: "typescript(no-non-null-asserted-optional-chain)", line: 3 }]);
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

  test("stops at nested callback boundaries while checking nested Effect bodies", async () => {
    expect(
      await lint(
        [
          "declare const Effect: any;",
          "export const a = Effect.gen(function* () {",
          "  const transport = async () => { throw new TypeError('offline'); };",
          "  const writer = () => { throw new Error('injected defect'); };",
          "  const producer = { read() { throw new Error('invariant'); } };",
          "  yield* Effect.gen(function* () { throw new Error('expected failure'); });",
          "  yield* Effect.fnUntraced(function* () { throw new Error('expected failure'); })();",
          "});",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-throw-in-effect)", line: 6 },
      { code: "skit(no-throw-in-effect)", line: 7 },
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

  test("allows native message formatting but still rejects prototype recovery", async () => {
    expect(
      await lint(
        [
          "declare const cause: unknown;",
          "declare const error: unknown;",
          "export const a = cause instanceof Error ? cause.message : String(cause);",
          "export const b = error instanceof Error ? error.message : 'Invalid manifest';",
          "export const c = error instanceof TypeError ? error.message : 'Invalid manifest';",
          "export const d = error instanceof Error ? 'recover' : 'fail';",
          "export const e = error instanceof Error ? cause.message : 'fail';",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "skit(no-error-instanceof)", line: 5 },
      { code: "skit(no-error-instanceof)", line: 6 },
      { code: "skit(no-error-instanceof)", line: 7 },
    ]);
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

describe("skit/banned-terms", () => {
  test("reads the verbs CONTEXT.md avoids, leaving the Release exception to review", () => {
    expect(
      bannedVerbs(readFileSync(join(import.meta.dirname, "..", "CONTEXT.md"), "utf8")),
    ).toEqual(expect.arrayContaining(["retain", "observe", "bind", "project", "reconcile"]));
    expect(
      bannedVerbs(readFileSync(join(import.meta.dirname, "..", "CONTEXT.md"), "utf8")),
    ).not.toContain("publish");
  });

  test("recognizes a verb's forms and nouns, not words that merely share letters", () => {
    const verbs = ["retain", "acquire", "bind", "project", "observe"];
    for (const word of [
      "retained",
      "Retaining",
      "retention",
      "acquisition",
      "bindings",
      "projection",
    ])
      expect(bannedForm(word, verbs)).toBeDefined();
    for (const word of ["projector", "acquiesce", "observatory", "binary", "retail"])
      expect(bannedForm(word, verbs)).toBeUndefined();
  });

  test("rejects banned verbs in declared names and in text a person reads", async () => {
    expect(
      await lint(
        [
          "export function retainSnapshot() {}",
          'export const label = "Verifying retained copies";',
          "export const progress = (n: number) => `Restoring ${n} retained copies`;",
          "export class SkillBinding {}",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4].map((line) => ({ code: "skit(banned-terms)", line })));
  });

  test("allows contract names, outside APIs, and a harness's own projects", async () => {
    expect(
      await lint(
        [
          'export const kind = "retained_copies";',
          'export const status = ["retained", "observed"];',
          'export const run = (effect: { bind: (name: string) => void }) => effect.bind("x");',
          'export const help = "Codex project configuration";',
          "export const codexProjectRoot = '.codex';",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("skit/no-middle-dot-delimiter", () => {
  test("rejects JSX text and attributes", async () => {
    const dot = String.fromCodePoint(0xb7);
    expect(await lint(`<div title="one ${dot} two">one ${dot} two</div>`, "tsx")).toEqual(
      [1, 1].map((line) => ({ code: "skit(no-middle-dot-delimiter)", line })),
    );
  });
  test("rejects literal and escaped middle dots in strings and templates", async () => {
    expect(
      await lint(
        [
          `const a = "one ${String.fromCodePoint(0xb7)} two";`,
          'const b = "one \\u00b7 two";',
          "const c = `one " + String.fromCodePoint(0xb7) + " ${name}`;",
          "const d = `one \\u00b7 ${name}`;",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4].map((line) => ({ code: "skit(no-middle-dot-delimiter)", line })));
  });

  test("allows ordinary separators and middle dots in comments", async () => {
    expect(
      await lint(
        "// one " +
          String.fromCodePoint(0xb7) +
          ' two\nconst a = "one | two"; const b = `one (${name})`;',
      ),
    ).toEqual([]);
  });
});
