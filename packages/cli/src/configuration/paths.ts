import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Config, Context, Effect, Layer, Option } from "effect";

export interface ResolvedSkitPaths {
  readonly userHome: string;
  readonly skitHome: string;
  readonly configHome: string;
  readonly stateHome: string;
  readonly authPath: string;
  readonly syncBindingsPath: string;
  readonly libraryStatePath: string;
  readonly originalsPath: string;
  readonly variantsPath: string;
}

export class SkitPaths extends Context.Service<SkitPaths, ResolvedSkitPaths>()("skit/SkitPaths") {}

/** Read environment configuration only when constructing an application boundary. */
export const resolveSkitPaths = Effect.fn("Configuration.resolvePaths")(function* (
  home?: string,
  userHome = homedir(),
) {
  const skitHome = resolve(
    home === undefined
      ? yield* Config.String("SKIT_HOME").pipe(Config.withDefault(join(userHome, ".skit")))
      : home,
  );
  const configHome = resolve(
    yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(join(userHome, ".config"))),
  );
  const stateHome = resolve(
    yield* Config.String("XDG_STATE_HOME").pipe(
      Config.withDefault(join(userHome, ".local", "state")),
    ),
  );
  return SkitPaths.of({
    userHome: resolve(userHome),
    skitHome,
    configHome,
    stateHome,
    authPath: join(skitHome, "auth.json"),
    syncBindingsPath: join(skitHome, "sync-bindings.json"),
    libraryStatePath: join(skitHome, "state.json"),
    originalsPath: join(skitHome, "originals"),
    variantsPath: join(skitHome, "variants"),
  });
});

/** Standalone adapters may construct paths; application workflows reuse their boundary's value. */
export const configurationPaths = Effect.fn("Configuration.paths")(function* (home?: string) {
  const existing = yield* Effect.serviceOption(SkitPaths);
  if (Option.isSome(existing) && (home === undefined || resolve(home) === existing.value.skitHome))
    return existing.value;
  return yield* resolveSkitPaths(home);
});

export const skitPathsLayer = (home?: string) => Layer.effect(SkitPaths, resolveSkitPaths(home));

/** Resolve flags before constructing services and share that snapshot with the entire command. */
export function withCommandPaths<A, E, R>(
  home: Option.Option<string>,
  command: (paths: ResolvedSkitPaths) => Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(resolveSkitPaths(Option.getOrUndefined(home)), (paths) =>
    command(paths).pipe(Effect.provideService(SkitPaths, paths)),
  );
}
