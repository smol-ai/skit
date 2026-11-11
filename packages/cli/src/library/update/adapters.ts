import { Cause, Effect, Layer, Option } from "effect";
import { authorLayer, updateAuthorWorkspace } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
import type { SourceUpdateAdapters } from "@smolai/skit-core/library/update";
import { RegistryHttp, registryHttpLayer } from "../../registry/registry-http.js";
import { authorRegistry } from "../../registry/author-sync.js";
import { importSource, type SkitSource } from "@smolai/skit-core/library/source";
import { sourceRequest } from "../../registry/library-source.js";
import { LibraryProgress } from "./progress.js";

const updateAuthoredSkills = Effect.fn("CLI.update.authored")(function* (
  input: string,
  owner: {
    readonly library: Library.Interface;
    readonly home: string;
    readonly expectedImportId: string;
  },
) {
  const { home, library } = owner;
  const supplied = yield* Effect.serviceOption(RegistryHttp);
  const transport = Option.isSome(supplied)
    ? Layer.succeed(RegistryHttp, supplied.value)
    : registryHttpLayer();
  const outcome = yield* updateAuthorWorkspace(
    input,
    { home, expectedImportId: owner.expectedImportId },
    authorRegistry(home),
  ).pipe(
    Effect.provideService(Library.Service, library),
    Effect.provide(Layer.merge(authorLayer({ home }), transport)),
  );
  const installation = yield* Effect.fromResult(outcome.installation);
  return {
    installed: installation.installed,
    issues: installation.issues,
    ...(outcome.installation_error === undefined
      ? {}
      : { installation_error: Cause.fail(outcome.installation_error) }),
    ...(outcome.sync === undefined
      ? {}
      : outcome.sync._tag === "Failure"
        ? { sync_status: "failed", sync_error: Cause.fail(outcome.sync.failure) }
        : { sync_status: outcome.sync.success.status }),
  };
});
const importUpdateSource = Effect.fn("CLI.update.importSource")(function* (
  source: SkitSource,
  previousSkillPaths: readonly string[],
  imports: Library.Interface["import"],
) {
  return yield* importSource(imports, yield* sourceRequest(source, previousSkillPaths));
});

type AdapterError =
  | Effect.Error<ReturnType<typeof updateAuthoredSkills>>
  | Effect.Error<ReturnType<typeof importUpdateSource>>;
type AdapterContext =
  | Effect.Services<ReturnType<typeof updateAuthoredSkills>>
  | Effect.Services<ReturnType<typeof importUpdateSource>>;

/** CLI lends Registry access and rendering; the Author owner coordinates authored updates. */
export const updateAdapters: Effect.Effect<SourceUpdateAdapters<AdapterError, AdapterContext>> =
  Effect.map(LibraryProgress, (progress) => ({
    progress,
    updateAuthoredSkills,
    importSource: importUpdateSource,
  }));
