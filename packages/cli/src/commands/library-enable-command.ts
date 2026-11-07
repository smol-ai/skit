import { OptionCombinationInvalid } from "./input-failures.js";
import { promptsAllowed } from "../terminal/interactivity.js";
import { type InstallScope as Scope } from "@smolai/skit-core/library";

import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolve } from "node:path";

import { CommandMetadata } from "./metadata.js";
import { enableOutputContracts, presentSetEnabled } from "../library/enable.js";
import { localFlags, optionalString } from "./parameters.js";
import { invocationOptions, type InvocationOption } from "@smolai/skit-core/library/session";

const subject = Argument.String("skill-or-collection").pipe(Argument.optional);
const repo = optionalString("repo", "Use repository scope.");
const global = Flag.Boolean("global").pipe(
  Flag.withDescription("Use global scope, for every project, without asking."),
  Flag.withDefault(false),
);
const all = Flag.Boolean("all").pipe(
  Flag.withDescription("Select every eligible skill in the collection."),
  Flag.withDefault(false),
);
const invocation = Flag.Literals("invocation", invocationOptions).pipe(
  Flag.withDescription(
    "Override model invocation policy for every harness; Devin maps explicit to [user], implicit to [user, model], and host-policy preserves authored triggers.",
  ),
  Flag.optional,
);
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report installed-skill changes without applying them."),
  Flag.withDefault(false),
);
const allowDuplicate = Flag.Boolean("allow-duplicate").pipe(
  Flag.withDescription(
    "Explicitly allow another same-scope copy of a skill a harness can already find.",
  ),
  Flag.withDefault(false),
);

export const setEnabledCliCommand = (enabled: boolean) => {
  const action = enabled ? "enable" : "disable";
  return Command.make(
    action,
    {
      subject,
      repo,
      global,
      all,
      invocation,
      dryRun,
      ...(enabled ? { allowDuplicate } : {}),
      ...localFlags,
    },
    (input) =>
      Effect.gen(function* () {
        if (input.global && Option.isSome(input.repo))
          return yield* new OptionCombinationInvalid({
            detail: "Choose one scope: --global or --repo <path>",
          });
        const selectedSubject = Option.getOrUndefined(input.subject);
        const selectedScope: Scope | undefined = input.global
          ? { kind: "global" }
          : Option.getOrUndefined(
              Option.map(input.repo, (root): Scope => ({
                kind: "repository",
                root: resolve(root),
              })),
            );
        const selectedInvocation = Option.getOrUndefined(input.invocation) as
          | InvocationOption
          | undefined;
        const interactive = promptsAllowed({ json: input.json });

        yield* presentSetEnabled({
          action,
          enabled,
          subject: selectedSubject,
          scope: selectedScope,
          cwd: resolve(process.cwd()),
          all: input.all,
          allowDuplicate: input.allowDuplicate,
          invocation: selectedInvocation,
          dryRun: input.dryRun,
          interactive,
        });
      }),
  ).pipe(
    Command.withDescription(
      `${enabled ? "Enable" : "Disable"} Skills from your Library for every harness at a scope.`,
    ),
    Command.withExamples(
      enabled
        ? [{ command: "skit enable review" }, { command: "skit enable owner/tools --all" }]
        : [{ command: "skit disable review" }, { command: "skit disable owner/tools --all" }],
    ),
    Command.annotate(CommandMetadata, {
      effects: { capabilities: ["filesystem.read", "filesystem.write"] },
      outputSchemas: enabled
        ? [enableOutputContracts.enable, enableOutputContracts.enablePlan]
        : [enableOutputContracts.disable, enableOutputContracts.disablePlan],
      exitCodes: [0, 1, 11, 12, 64, 65],
      interactive: true,
    }),
  );
};
