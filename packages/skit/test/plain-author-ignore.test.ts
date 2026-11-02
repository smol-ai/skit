import { it, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";
import { systemError } from "effect/PlatformError";
import { join } from "node:path";
import { skitLayer, SourceProcess, walkAuthorTree } from "../src/index.js";
import { authorIgnoreRepositoryLayer } from "../src/artifact/plain-author-ignore.js";

it.effect("plain Author scope honors native nested rules before reading bytes or descending", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plain-ignore-" });
    yield* fs.makeDirectory(join(root, "ignored"));
    yield* fs.makeDirectory(join(root, "cache"));
    yield* fs.makeDirectory(join(root, "nested"));
    yield* fs.makeDirectory(join(root, "empty"));
    yield* fs.writeFileString(
      join(root, ".gitignore"),
      ".env\nignored/\ncache/\n*.log\n!keep.log\n",
    );
    yield* fs.writeFileString(join(root, "nested/.gitignore"), "*.tmp\n!keep.tmp\n");
    for (const path of [
      ".env",
      "ignored/credential",
      "cache/secret.txt",
      "cache2",
      "nested/cache",
      "nested/private.tmp",
      "cafe\u0301.log",
      "cafe\u0301.md",
      "keep.log",
      "nested/keep.tmp",
      "readme.md",
    ])
      yield* fs.writeFileString(join(root, path), "fixture\n");
    const forbidden = new Set([
      join(root, ".env"),
      join(root, "ignored"),
      join(root, "cache"),
      join(root, "nested/private.tmp"),
      join(root, "cafe\u0301.log"),
    ]);
    const guarded = {
      ...fs,
      readFile: (path: string) =>
        forbidden.has(path) ? Effect.die("read ignored bytes") : fs.readFile(path),
      readDirectory: (path: string) =>
        forbidden.has(path)
          ? Effect.die("descended into ignored directory")
          : fs.readDirectory(path),
    };
    const raw = yield* walkAuthorTree(root, "verbatim").pipe(
      Effect.provideService(FileSystem.FileSystem, guarded),
    );
    const files = raw.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    expect(files).toEqual([
      ".gitignore",
      "cache2",
      "cafe\u0301.md",
      "keep.log",
      "nested/.gitignore",
      "nested/cache",
      "nested/keep.tmp",
      "readme.md",
    ]);
    expect((yield* walkAuthorTree(root, "normalized")).map((entry) => entry.path)).toEqual(
      files.map((path) => path.normalize("NFC")),
    );
    expect(raw).toContainEqual({ path: "empty", kind: "directory" });
    expect(yield* fs.exists(join(root, ".git"))).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a populated 1,000-directory plain tree uses a bounded number of Git processes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const process = yield* SourceProcess;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plain-large-tree-" });
    yield* Effect.forEach(
      Array.from({ length: 1000 }, (_, index) => index),
      (index) =>
        Effect.gen(function* () {
          const directory = join(root, `member-${index}`);
          yield* fs.makeDirectory(directory);
          yield* fs.writeFileString(join(directory, "SKILL.md"), "# Example\n");
        }),
      { concurrency: 16 },
    );
    let calls = 0;
    const withinBudget = Effect.sync(() => expect(++calls).toBeLessThanOrEqual(4));
    const entries = yield* walkAuthorTree(root, "verbatim").pipe(
      Effect.provideService(SourceProcess, {
        run: (command, args, options) =>
          withinBudget.pipe(Effect.andThen(process.run(command, args, options))),
        output: (command, args, options) =>
          withinBudget.pipe(Effect.andThen(process.output(command, args, options))),
      }),
    );
    expect(entries.filter((entry) => entry.kind === "file")).toHaveLength(1000);
    expect(entries.filter((entry) => entry.kind === "directory")).toHaveLength(1000);
    expect(calls).toBeLessThanOrEqual(4);
    expect(yield* fs.exists(join(root, ".git"))).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "plain Author scope honors configured global excludes and cleans its private repository",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const process = yield* SourceProcess;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plain-global-" });
      const root = join(temporary, "author");
      yield* fs.makeDirectory(root);
      const excludes = join(temporary, "global-excludes");
      yield* fs.writeFileString(excludes, ".env\n");
      yield* fs.writeFileString(join(root, ".env"), "private\n");
      yield* fs.writeFileString(join(root, "kept.md"), "public\n");
      const repositories: string[] = [];
      const environment = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.excludesFile",
        GIT_CONFIG_VALUE_0: excludes,
      };
      const entries = yield* walkAuthorTree(root, "verbatim").pipe(
        Effect.provideService(SourceProcess, {
          run: (command, args, options) => {
            if (args.includes("init")) repositories.push(args.at(-1) ?? "");
            return process.run(command, args, {
              ...options,
              environment: { ...options?.environment, ...environment },
            });
          },
          output: (command, args, options) =>
            process.output(command, args, {
              ...options,
              environment: { ...options?.environment, ...environment },
            }),
        }),
        Effect.provide(Layer.fresh(authorIgnoreRepositoryLayer)),
      );
      expect(entries.map((entry) => entry.path)).toEqual(["kept.md"]);
      expect(repositories).toHaveLength(1);
      for (const repository of repositories) expect(yield* fs.exists(repository)).toBe(false);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a missing Git executable is retried instead of cached permanently", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const process = yield* SourceProcess;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plain-retry-git-" });
    yield* fs.writeFileString(join(root, "kept.md"), "content\n");
    let initializations = 0;
    const runner = {
      ...process,
      run: (
        command: string,
        args: readonly string[],
        options?: Parameters<typeof process.run>[2],
      ) => {
        if (args.includes("init") && ++initializations === 1)
          return Effect.fail(
            systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: "git",
            }),
          );
        return process.run(command, args, options);
      },
    };
    const scan = walkAuthorTree(root, "verbatim").pipe(
      Effect.provideService(SourceProcess, runner),
    );
    expect((yield* scan).map((entry) => entry.path)).toEqual(["kept.md"]);
    yield* fs.writeFileString(join(root, ".gitignore"), "kept.md\n");
    expect((yield* scan).map((entry) => entry.path)).toEqual([".gitignore"]);
    expect(initializations).toBe(2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("private Git commands cannot inherit writable repository paths from the caller", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const process = yield* SourceProcess;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "skit-private-git-env-" });
    const root = join(temporary, "author");
    yield* fs.makeDirectory(root);
    yield* fs.writeFileString(join(root, "kept.md"), "content\n");
    const index = join(temporary, "outside-index");
    yield* fs.writeFileString(index, "not a Git index\n");
    const ambient = {
      GIT_DIR: join(temporary, "outside-git"),
      GIT_COMMON_DIR: join(temporary, "outside-common"),
      GIT_WORK_TREE: join(temporary, "outside-worktree"),
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: join(temporary, "outside-objects"),
    };
    const entries = yield* walkAuthorTree(root, "verbatim").pipe(
      Effect.provideService(SourceProcess, {
        run: (command, args, options) =>
          process.run(command, args, {
            ...options,
            environment: { ...ambient, ...options?.environment },
          }),
        output: (command, args, options) =>
          process.output(command, args, {
            ...options,
            environment: { ...ambient, ...options?.environment },
          }),
      }),
    );
    expect(entries.map((entry) => entry.path)).toEqual(["kept.md"]);
    expect(yield* fs.readFileString(index)).toBe("not a Git index\n");
    for (const path of [
      ambient.GIT_DIR,
      ambient.GIT_COMMON_DIR,
      ambient.GIT_WORK_TREE,
      ambient.GIT_OBJECT_DIRECTORY,
    ])
      expect(yield* fs.exists(path)).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each([false, true])(
  "missing Git with ignore rules = %s fails closed, without rules preserves content",
  (rules) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plain-no-git-" });
      yield* fs.writeFileString(join(root, "kept.md"), "content\n");
      if (rules) yield* fs.writeFileString(join(root, ".gitignore"), "kept.md\n");
      const unavailable = () =>
        Effect.fail(
          systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            pathOrDescriptor: "git",
          }),
        );
      const result = yield* Effect.result(
        walkAuthorTree(root, "verbatim").pipe(
          Effect.provideService(SourceProcess, { run: unavailable, output: unavailable }),
        ),
      );
      if (rules)
        expect(result).toMatchObject({
          failure: { _tag: "TreeError", reason: { _tag: "GitInspectionFailed" } },
        });
      else {
        expect(Result.isSuccess(result)).toBe(true);
        if (Result.isSuccess(result))
          expect(result.success.map((entry) => entry.path)).toEqual(["kept.md"]);
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reuses only the empty repository; file membership stays fresh between scans", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const process = yield* SourceProcess;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plain-reuse-" });
    yield* fs.writeFileString(join(root, "kept.md"), "first\n");
    let initializations = 0;
    let listings = 0;
    const runner = {
      ...process,
      run: (
        command: string,
        args: readonly string[],
        options?: Parameters<typeof process.run>[2],
      ) => {
        if (args.includes("init")) initializations++;
        return process.run(command, args, options);
      },
      output: (
        command: string,
        args: readonly string[],
        options?: Parameters<typeof process.output>[2],
      ) => {
        if (args.includes("ls-files")) listings++;
        return process.output(command, args, options);
      },
    };
    const scan = walkAuthorTree(root, "verbatim").pipe(
      Effect.provideService(SourceProcess, runner),
    );
    expect((yield* scan).map((entry) => entry.path)).toEqual(["kept.md"]);
    yield* fs.writeFileString(join(root, ".gitignore"), "kept.md\n");
    expect((yield* scan).map((entry) => entry.path)).toEqual([".gitignore"]);
    expect(initializations).toBe(1);
    expect(listings).toBe(2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each([
  { exitCode: 128, output: ".env\0" },
  { exitCode: 0, output: ".env" },
  { exitCode: 1, output: ".env\0" },
  { exitCode: 0, output: "not-requested\0" },
])("partial or invalid private ignore query fails before reading any file (%j)", (response) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const process = yield* SourceProcess;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plain-query-failure-" });
    yield* fs.makeDirectory(join(root, ".env"));
    yield* fs.writeFileString(join(root, ".env/credential"), "never read\n");
    const result = yield* Effect.result(
      walkAuthorTree(root, "verbatim").pipe(
        Effect.provideService(SourceProcess, {
          ...process,
          output: (_command, args) =>
            args.includes("ls-files")
              ? Effect.succeed({ stdout: new Uint8Array(), stderr: "", exitCode: 0 })
              : Effect.succeed({
                  stdout: Buffer.from(response.output),
                  stderr: "",
                  exitCode: response.exitCode,
                }),
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFile: () => Effect.die("file read before scope established"),
        }),
      ),
    );
    expect(result).toMatchObject({
      failure: { _tag: "TreeError", reason: { _tag: "GitInspectionFailed" } },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
