import { Option, Record } from "effect";
import { CliConfig, Flag, GlobalFlag } from "effect/cli";
import type { HarnessName, SkillsDirectoryOverrides } from "@smolai/skit-core/harnesses";
import { inventoryRootOptions as deviceRoots } from "@smolai/skit-core/library/routing";
import type { ResolvedSkitConfiguration } from "@smolai/skit-core/platform";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";

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
export const JsonOutputFlag = GlobalFlag.Setting("json-output")({
  flag: jsonFlag,
});

export const jsonRequested = (argv: readonly string[] = process.argv.slice(2)): boolean => {
  // Select output even when parsing fails. Effect remains responsible for validation;
  // mirror the installed Boolean literals here and verify them against the real parser.
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") break;
    if (token === "--no-json") json = false;
    else if (token === "--json" || token.startsWith("--json=")) {
      const value = token === "--json" ? argv[index + 1] : token.slice("--json=".length);
      if (value !== undefined && ["false", "no", "off", "0", "n"].includes(value)) json = false;
      else if (
        value === undefined ||
        token === "--json" ||
        ["true", "yes", "on", "1", "y"].includes(value)
      )
        json = true;
    }
  }
  return json;
};

export const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  );

export const homeFlag = optionalString("home", "Override the SKIT state directory.");
const codexRootFlag = optionalString(
  "codex-root",
  "Override the shared .agents skills directory that Codex and other harnesses read.",
);
const claudeRootFlag = optionalString(
  "claude-root",
  "Override the Claude skills directory; treats Claude Code as present.",
);
const opencodeRootFlag = optionalString(
  "opencode-root",
  "Scan an OpenCode skills directory for inventory; SKIT does not install there.",
);
const devinRootFlag = Flag.String("devin-root").pipe(
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

/** The parsed root flags: skills directories named on the command line. */
export interface RootFlags {
  readonly codexRoot: string | undefined;
  readonly claudeRoot: string | undefined;
  readonly opencodeRoot: string | undefined;
  readonly devinRoot: readonly string[];
}

export function rootOverrides(input: Partial<RootFlags>): SkillsDirectoryOverrides {
  const overrides: Record<HarnessName, readonly string[]> = {
    codex: input.codexRoot === undefined ? [] : [input.codexRoot],
    "claude-code": input.claudeRoot === undefined ? [] : [input.claudeRoot],
    opencode: input.opencodeRoot === undefined ? [] : [input.opencodeRoot],
    devin: input.devinRoot ?? [],
  };
  return Record.filter(overrides, (roots) => roots.length > 0);
}

export function inventoryRootOptions(
  input: Partial<RootFlags>,
  paths: ResolvedSkitConfiguration,
): InventoryRootOptions {
  return deviceRoots(paths, rootOverrides(input));
}
