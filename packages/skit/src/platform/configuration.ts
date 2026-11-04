import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";

export interface ResolvedSkitConfiguration {
  readonly userHome: string;
  readonly skitHome: string;
  readonly configHome: string;
  readonly stateHome: string;
  /** Absent/empty XDG state means skills.sh stores its lock under ~/.agents. */
  readonly xdgStateHome: string | undefined;
  readonly authPath: string;
  readonly syncBindingsPath: string;
  /** `SKIT_SERVER_URL`; an environment credential applies only to this origin. */
  readonly registryOrigin: string | undefined;
  /** `SKIT_TOKEN`, redacted so the configuration snapshot never logs or traces it. */
  readonly registryToken: Redacted.Redacted<string> | undefined;
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
  // An empty variable is unset, so `NAME= skit …` can clear an inherited value.
  const nonEmpty = (name: string) =>
    Config.option(Config.String(name)).pipe(
      Config.map((value) => Option.getOrUndefined(Option.filter(value, (text) => text !== ""))),
    );
  const xdgDirectory = (name: string) =>
    nonEmpty(name).pipe(Config.map((path) => (path === undefined ? undefined : resolve(path))));
  const xdgConfigHome = yield* xdgDirectory("XDG_CONFIG_HOME");
  const xdgStateHome = yield* xdgDirectory("XDG_STATE_HOME");
  const registryToken = yield* nonEmpty("SKIT_TOKEN");
  const configHome = xdgConfigHome ?? resolve(userHome, ".config");
  const stateHome = xdgStateHome ?? resolve(userHome, ".local", "state");
  return SkitConfiguration.of({
    userHome: resolve(userHome),
    ...pathsForHome(skitHome),
    configHome,
    stateHome,
    xdgStateHome,
    registryOrigin: yield* nonEmpty("SKIT_SERVER_URL"),
    registryToken: registryToken === undefined ? undefined : Redacted.make(registryToken),
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
