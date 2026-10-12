import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Config, Context, Effect, Layer, Option } from "effect";

export interface ResolvedSkitPaths {
  readonly userHome: string;
  readonly skitHome: string;
  readonly configHome: string;
  readonly stateHome: string;
  /** Absent/empty XDG state means skills.sh stores its lock under ~/.agents. */
  readonly xdgStateHome: string | undefined;
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
  const xdgDirectory = (name: string) =>
    Config.option(Config.String(name)).pipe(
      Config.map((value) =>
        Option.getOrUndefined(
          Option.map(
            Option.filter(value, (path) => path !== ""),
            (path) => resolve(path),
          ),
        ),
      ),
    );
  const xdgConfigHome = yield* xdgDirectory("XDG_CONFIG_HOME");
  const xdgStateHome = yield* xdgDirectory("XDG_STATE_HOME");
  const configHome = xdgConfigHome ?? resolve(userHome, ".config");
  const stateHome = xdgStateHome ?? resolve(userHome, ".local", "state");
  return SkitPaths.of({
    userHome: resolve(userHome),
    skitHome,
    configHome,
    stateHome,
    xdgStateHome,
    authPath: join(skitHome, "auth.json"),
    syncBindingsPath: join(skitHome, "sync-bindings.json"),
    libraryStatePath: join(skitHome, "state.json"),
    originalsPath: join(skitHome, "originals"),
    variantsPath: join(skitHome, "variants"),
  });
});

/** Concrete root overrides derive paths from the supplied application snapshot. */
export const configurationPaths = Effect.fn("Configuration.paths")(function* (home?: string) {
  const paths = yield* SkitPaths;
  if (home === undefined || resolve(home) === paths.skitHome) return paths;
  const skitHome = resolve(home);
  return SkitPaths.of({
    ...paths,
    skitHome,
    authPath: join(skitHome, "auth.json"),
    syncBindingsPath: join(skitHome, "sync-bindings.json"),
    libraryStatePath: join(skitHome, "state.json"),
    originalsPath: join(skitHome, "originals"),
    variantsPath: join(skitHome, "variants"),
  });
});

/** Construct paths once at the executable or standalone application boundary. */
export const skitPathsLayer = (home?: string) => Layer.effect(SkitPaths, resolveSkitPaths(home));
