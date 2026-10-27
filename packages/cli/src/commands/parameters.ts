import { Option, Record } from "effect";
import { CliConfig, Flag, GlobalFlag } from "effect/cli";
import type { HarnessName } from "@smolai/skit-core";
import type { ResolvedSkitConfiguration } from "../configuration/skit-configuration.js";
import type { InventoryRootOptions } from "../projection/roots.js";

/**
 * Effect's built-in global flags, without the interactive command wizard. SKIT asks its own
 * questions, and the wizard ignored them: without a terminal it printed a prompt to stdout and
 * exited 0 without running anything, which an agent reads as success. Execution and the help
 * documents the command manifest is generated from share this grammar.
 */
export const skitCliConfigLayer = CliConfig.layer({
  builtIns: GlobalFlag.BuiltIns.filter((flag) => flag !== GlobalFlag.Wizard),
});

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
  "Override the shared .agents skills directory that Codex and other agents read.",
);
export const claudeRootFlag = optionalString(
  "claude-root",
  "Override the Claude skills directory; treats Claude Code as present.",
);
export const opencodeRootFlag = optionalString(
  "opencode-root",
  "Scan an OpenCode skills directory for inventory; SKIT does not install there.",
);
export const devinRootFlag = Flag.String("devin-root").pipe(
  Flag.withDescription(
    "Scan additional Devin skills directories for inventory without changing install destinations.",
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
): InventoryRootOptions {
  const overrides: Record<HarnessName, readonly string[]> = {
    codex: Option.toArray(input.codexRoot),
    "claude-code": Option.toArray(input.claudeRoot),
    opencode: Option.toArray(input.opencodeRoot),
    devin: input.devinRoot,
  };
  return {
    home: paths.userHome,
    configHome: paths.configHome,
    overrides: Record.filter(overrides, (roots) => roots.length > 0),
  };
}

export const optionValue = <A>(value: Option.Option<A>): A | undefined =>
  Option.getOrUndefined(value);
