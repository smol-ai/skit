import { Option } from "effect";
import { Flag, GlobalFlag } from "effect/cli";
import type { ResolvedSkitConfiguration } from "../configuration/skit-configuration.js";

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit structured JSON."),
  Flag.withDefault(false),
);

// Effect CLI only accepts flags on an intermediate command path when they are declared global.
// The entrypoint still owns the value because it must select a renderer before parsing can fail.
export const JsonOutputFlag = GlobalFlag.Setting("json-output")({ flag: jsonFlag });

export const jsonRequested = (argv: readonly string[] = process.argv.slice(2)): boolean => {
  const boundary = argv.indexOf("--");
  return argv.slice(0, boundary === -1 ? undefined : boundary).includes("--json");
};

export const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

export const homeFlag = optionalString("home", "Override the SKIT state directory.");
export const codexRootFlag = optionalString(
  "codex-root",
  "Override the shared .agents skills root that Codex and other agents read.",
);
export const claudeRootFlag = optionalString(
  "claude-root",
  "Override the Claude skills root; treats Claude Code as present.",
);
export const opencodeRootFlag = optionalString(
  "opencode-root",
  "Scan an OpenCode skills root for inventory; SKIT does not project there.",
);
export const devinRootFlag = Flag.String("devin-root").pipe(
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

export function inventoryRootOptions(
  input: {
    readonly codexRoot: Option.Option<string>;
    readonly claudeRoot: Option.Option<string>;
    readonly opencodeRoot: Option.Option<string>;
    readonly devinRoot: readonly string[];
  },
  paths: ResolvedSkitConfiguration,
) {
  return {
    home: paths.userHome,
    configHome: paths.configHome,
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
