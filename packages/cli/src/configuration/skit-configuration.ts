import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Config, Context, Effect, Layer, Option } from "effect";

export interface ResolvedSkitConfiguration {
  readonly userHome: string;
  readonly skitHome: string;
  readonly configHome: string;
  readonly stateHome: string;
  /** Absent/empty XDG state means skills.sh stores its lock under ~/.agents. */
  readonly xdgStateHome: string | undefined;
  readonly authPath: string;
  readonly syncBindingsPath: string;
}

export class SkitConfiguration extends Context.Service<
  SkitConfiguration,
  ResolvedSkitConfiguration
>()("skit/SkitConfiguration") {}

const pathsForHome = (home: string) => {
  const skitHome = resolve(home);
  return {
    skitHome,
    authPath: join(skitHome, "auth.json"),
    syncBindingsPath: join(skitHome, "sync-bindings.json"),
  };
};

/** Resolve process inputs and CLI-owned paths once at the application boundary. */
export const resolveSkitConfiguration = Effect.fn("Configuration.resolve")(function* (
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
  return SkitConfiguration.of({
    userHome: resolve(userHome),
    ...pathsForHome(skitHome),
    configHome,
    stateHome,
    xdgStateHome,
  });
});

/** Concrete root overrides derive paths from the supplied application snapshot. */
export const configurationForHome = Effect.fn("Configuration.forHome")(function* (home?: string) {
  const paths = yield* SkitConfiguration;
  if (home === undefined || resolve(home) === paths.skitHome) return paths;
  return SkitConfiguration.of({ ...paths, ...pathsForHome(home) });
});

/** Construct the shared configuration at an executable or standalone application boundary. */
export const skitConfigurationLayer = (home?: string) =>
  Layer.effect(SkitConfiguration, resolveSkitConfiguration(home));
