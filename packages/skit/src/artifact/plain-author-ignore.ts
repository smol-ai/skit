import {
  Array,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  ScopedCache,
  Stream,
} from "effect";
import { SourceProcess, type SourceProcessFailure } from "../platform/source-process.js";
import { LinkStat } from "../platform/link-stat.js";
import { TreeError } from "../shared/tree-error.js";
import { decodeUtf8 } from "../shared/text.js";
import { parentDirectories } from "../shared/relative-path.js";

const failure = (detail: string) =>
  new TreeError({ reason: { _tag: "GitInspectionFailed", detail } });

const privateEnvironment = (path: Path.Path, repository: string, root?: string) => ({
  GIT_DIR: repository,
  GIT_COMMON_DIR: repository,
  GIT_WORK_TREE: root,
  GIT_INDEX_FILE: path.join(repository, "index"),
  GIT_OBJECT_DIRECTORY: path.join(repository, "objects"),
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
});

/** Git's `-z` output as its NUL-terminated records, or a failure naming the `query`. */
const records = (stdout: Uint8Array, query: string) =>
  Option.match(decodeUtf8(stdout), {
    onNone: () => Effect.fail(failure(`${query} returned invalid UTF-8`)),
    onSome: (text) =>
      text === ""
        ? Effect.succeed(Array.empty<string>())
        : text.endsWith("\0")
          ? Effect.succeed(text.slice(0, -1).split("\0"))
          : Effect.fail(failure(`${query} returned incomplete results`)),
  });

export class AuthorIgnoreRepository extends Context.Service<
  AuthorIgnoreRepository,
  {
    /** The private bare repository, made once per runtime scope. */
    readonly repository: Effect.Effect<
      string,
      TreeError | SourceProcessFailure,
      FileSystem.FileSystem | Path.Path | SourceProcess
    >;
  }
>()("skit/AuthorIgnoreRepository") {}

/** One immutable, index-free repository per runtime scope, shared across Author roots. */
export const authorIgnoreRepositoryLayer = Layer.effect(
  AuthorIgnoreRepository,
  Effect.gen(function* () {
    const cache = yield* ScopedCache.makeWith({
      capacity: 1,
      requireServicesAt: "lookup",
      lookup: (_key: "repository") =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const repository = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-ignore-" });
          const result = yield* (yield* SourceProcess).run(
            "git",
            [
              "-c",
              "core.precomposeunicode=false",
              "init",
              "--bare",
              "--quiet",
              "--template=",
              repository,
            ],
            { environment: privateEnvironment(path, repository) },
          );
          if (result.exitCode !== 0)
            return yield* failure("Cannot initialize private Git ignore evaluator");
          return repository;
        }),
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    });
    return AuthorIgnoreRepository.of({ repository: ScopedCache.get(cache, "repository") });
  }),
);

/** Scoped, index-free Git rules for an Author folder that has no worktree. */
export const makePlainAuthorIgnore = Effect.fn("Tree.makePlainAuthorIgnore")(function* (
  root: string,
) {
  const process = yield* SourceProcess;
  const links = yield* LinkStat;
  const path = yield* Path.Path;
  const initialized = yield* (yield* AuthorIgnoreRepository).repository.pipe(
    Effect.asSome,
    // Without Git there is no evaluator; only a folder with no .gitignore can do without one.
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.mapError((error) => failure(String(error))),
  );
  if (Option.isNone(initialized))
    return (paths: readonly string[]) =>
      paths.some((entry) => entry.split("/").at(-1) === ".gitignore")
        ? Effect.fail(failure("Git is unavailable; cannot honor .gitignore in this Author folder"))
        : Effect.succeed(new Set<string>());
  const repository = initialized.value;
  const environment = privateEnvironment(path, repository, root);
  const prefix = [
    `--git-dir=${repository}`,
    `--work-tree=${root}`,
    "-c",
    "core.precomposeunicode=false",
    "-C",
    root,
  ];
  const listed = yield* process
    .output("git", [...prefix, "ls-files", "--others", "--exclude-standard", "-z", "--", "."], {
      environment,
    })
    .pipe(Effect.mapError((error) => failure(String(error))));
  if (listed.exitCode !== 0)
    return yield* failure(`Private Git inventory exited with ${listed.exitCode}`);
  const files = new Set(yield* records(listed.stdout, "Private Git inventory"));
  if ([...files].some((file) => file.endsWith("/")))
    return yield* failure("Embedded repository is outside plain Author inventory");
  const directories = new Set([...files].flatMap((file) => parentDirectories(file)));
  const checkDirectories = Effect.fn("Tree.checkPlainAuthorDirectories")(function* (
    paths: readonly string[],
  ) {
    if (paths.length === 0) return new Set<string>();
    const result = yield* process
      .output("git", [...prefix, "check-ignore", "--no-index", "--stdin", "-z"], {
        stdin: Stream.succeed(new TextEncoder().encode(`${paths.join("\0")}\0`)),
        environment,
      })
      .pipe(Effect.mapError((error) => failure(String(error))));
    if (result.exitCode !== 0 && result.exitCode !== 1)
      return yield* failure(`Private Git ignore query exited with ${result.exitCode}`);
    const ignored = yield* records(result.stdout, "Private Git ignore query");
    // Git exits 0 exactly when it reports an ignored path.
    if ((result.exitCode === 0) !== ignored.length > 0)
      return yield* failure("Private Git ignore query returned incomplete results");
    const requested = new Set(paths);
    if (new Set(ignored).size !== ignored.length || ignored.some((entry) => !requested.has(entry)))
      return yield* failure("Private Git ignore query returned unexpected paths");
    return new Set(ignored);
  });
  return Effect.fn("Tree.checkPlainAuthorIgnore")(function* (paths: readonly string[]) {
    const unknown = yield* Effect.forEach(
      paths.filter((entry) => !files.has(entry) && !directories.has(entry)),
      (entry) =>
        Effect.map(links.lstat(path.join(root, entry)), (info) => ({
          path: entry,
          directory: info.type === "Directory",
        })),
    );
    return new Set([
      ...unknown.filter((entry) => !entry.directory).map((entry) => entry.path),
      ...(yield* checkDirectories(
        unknown.filter((entry) => entry.directory).map((entry) => entry.path),
      )),
    ]);
  });
});
