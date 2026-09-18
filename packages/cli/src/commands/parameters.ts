import { Option } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit structured JSON."),
  Flag.withDefault(false),
);

// Effect CLI only accepts flags on an intermediate command path when they are declared global.
// The entrypoint still owns the value because it must select a renderer before parsing can fail.
export const JsonOutputFlag = GlobalFlag.setting("json-output")({ flag: jsonFlag });

export const jsonRequested = (argv: readonly string[] = process.argv.slice(2)): boolean => {
  const boundary = argv.indexOf("--");
  return argv.slice(0, boundary === -1 ? undefined : boundary).includes("--json");
};

export const optionalString = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

export const homeFlag = optionalString("home", "Override the SKIT state directory.");
export const codexRootFlag = optionalString("codex-root", "Override the Codex skills root.");
export const claudeRootFlag = optionalString("claude-root", "Override the Claude skills root.");
export const opencodeRootFlag = optionalString(
  "opencode-root",
  "Override the OpenCode skills root.",
);
export const devinRootFlag = Flag.string("devin-root").pipe(
  Flag.withDescription(
    "Scan additional Devin skills roots for inventory without changing projection targets.",
  ),
  Flag.atLeast(0),
  Flag.map((values) => values.flatMap((value) => value.split(",").filter(Boolean))),
);

export const localFlags = {
  json: jsonFlag,
  home: homeFlag,
  codexRoot: codexRootFlag,
  claudeRoot: claudeRootFlag,
  opencodeRoot: opencodeRootFlag,
  devinRoot: devinRootFlag,
};

export const homePath = (home: Option.Option<string>): string =>
  resolve(Option.getOrElse(home, () => process.env.SKIT_HOME ?? join(homedir(), ".skit")));

export function inventoryRootOptions(input: {
  readonly codexRoot: Option.Option<string>;
  readonly claudeRoot: Option.Option<string>;
  readonly opencodeRoot: Option.Option<string>;
  readonly devinRoot: readonly string[];
}) {
  return {
    home: homedir(),
    configHome: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    overrides: {
      codex: Option.getOrUndefined(input.codexRoot),
      claude: Option.getOrUndefined(input.claudeRoot),
      opencode: Option.getOrUndefined(input.opencodeRoot),
      devin: [...input.devinRoot],
    },
  };
}

export const optionValue = <A>(value: Option.Option<A>): A | undefined =>
  Option.getOrUndefined(value);
