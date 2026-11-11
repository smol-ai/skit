import { defineCommand } from "../commands/definition.js";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { authorWorkspaceLayer, watchAuthorWorkspace } from "@smolai/skit-core/author";
import { authorRegistry } from "../registry/author-sync.js";
import { authorLayer } from "../application.js";
import { CommandMetadata, credentialStoreReadSubprocesses } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { jsonFlag, optionalString } from "../commands/parameters.js";
import { result } from "../commands/result.js";
import { Renderer } from "../terminal/renderer.js";
import { authorInitCommand } from "./init.js";
import { validateCommand } from "./validate.js";
import { authorSyncCommand } from "./sync.js";
import { publishCommand } from "./publish.js";
import { authorListCommand } from "./list.js";
import { authorDeleteCommand } from "./delete.js";
import { authorInvocationCommand } from "./invocation.js";

const workspaceSubprocesses = ["git init --bare", "git ls-files", "git check-ignore"] as const;

const directory = Argument.String("directory").pipe(
  Argument.withDescription("Author Workspace directory; defaults to the current directory."),
  Argument.optional,
  Argument.map((value) => Option.getOrElse(value, () => ".")),
);
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Preview changes without applying them."),
  Flag.withDefault(false),
);

const init = defineCommand("init", { directory, json: jsonFlag }, ({ directory }) =>
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    const { initialized } = yield* authorInitCommand(directory);
    yield* renderer.result(result("init", { ...initialized, library_registration: "registered" }));
  }),
).pipe(
  Command.withDescription(
    "Experimental: initialize an Author Workspace and import it into the Library.",
  ),
  Command.withExamples([{ command: "skit author init ./my-skills" }]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: workspaceSubprocesses,
    },
    outputSchemas: [outputContracts.init],
    interactive: false,
  }),
  Command.provide(authorLayer),
);

const validate = defineCommand("validate", { directory, json: jsonFlag }, ({ directory }) =>
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    const { value, status } = yield* validateCommand(directory, "author");
    yield* renderer.result(
      result("validate", {
        valid: status === "valid" || status === "valid-with-warnings",
        status,
        identity: value.identity,
        diagnostics: value.diagnostics,
        audits: value.audits,
        assessments: value.assessments,
      }),
    );
  }),
).pipe(
  Command.withDescription("Experimental: validate authored skills and report diagnostics."),
  Command.withExamples([{ command: "skit author validate ." }]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: workspaceSubprocesses,
    },
    outputSchemas: [outputContracts.validate],
    interactive: false,
  }),
);

const sync = defineCommand(
  "sync",
  {
    directory,
    json: jsonFlag,
    apply: Flag.Boolean("apply").pipe(
      Flag.withDescription("Apply the planned author synchronization."),
      Flag.withDefault(false),
    ),
    to: optionalString("to", "First-sync destination: namespace/skit or a Registry URL."),
    visibility: Flag.Literals("visibility", ["private", "unlisted", "public"]).pipe(
      Flag.withDescription("Required visibility for the first sync."),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    allowLargeDeletion: Flag.Boolean("allow-large-deletion").pipe(
      Flag.withDescription("Allow the exact bulk deletion found by this sync."),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const home = (yield* SkitConfiguration).skitHome;
      const value = yield* authorSyncCommand({ ...input, root: input.directory, home });
      yield* renderer.result(result("sync", value));
    }),
).pipe(
  Command.withDescription(
    "Experimental: preview or apply manual synchronization of authored content with a Registry.",
  ),
  Command.withExamples([
    { command: "skit author sync --to me/my-skills --visibility private --apply" },
    { command: "skit author sync --apply" },
  ]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: {
      capabilities: [
        "filesystem.read",
        "filesystem.write",
        "network.read",
        "network.write",
        "process.execute",
      ],
      subprocesses: [...credentialStoreReadSubprocesses, ...workspaceSubprocesses],
    },
    outputSchemas: [outputContracts.sync],
    interactive: false,
  }),
  Command.provide(authorLayer),
);

const watch = defineCommand("watch", { directory, json: jsonFlag }, ({ directory }) =>
  Effect.gen(function* () {
    const home = (yield* SkitConfiguration).skitHome;
    const renderer = yield* Renderer;
    return yield* watchAuthorWorkspace(directory, { home }, authorRegistry(home), (event) =>
      renderer.result(result("authorWatch", event), { jsonLines: true }),
    );
  }),
).pipe(
  Command.withDescription(
    "Experimental: watch one connected Author Workspace, synchronize edits and update enabled installed skills until stopped.",
  ),
  Command.withExamples([{ command: "skit author watch ." }]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: {
      capabilities: [
        "filesystem.read",
        "filesystem.write",
        "network.read",
        "network.write",
        "process.execute",
      ],
      subprocesses: [...credentialStoreReadSubprocesses, ...workspaceSubprocesses],
    },
    outputSchemas: [outputContracts.authorWatch],
    interactive: false,
  }),
  Command.provide(authorLayer),
);

const publish = defineCommand(
  "publish",
  {
    directory,
    json: jsonFlag,
    version: Flag.String("version").pipe(
      Flag.withDescription("Exact immutable release version to publish."),
    ),
    revision: optionalString("revision", "Require this current revision when publishing."),
  },
  (input) =>
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const home = (yield* SkitConfiguration).skitHome;
      const value = yield* publishCommand({ ...input, root: input.directory, home });
      yield* renderer.result(result("publish", value));
    }),
).pipe(
  Command.withDescription(
    "Experimental: validate and publish an immutable release from a connected Author Workspace.",
  ),
  Command.withExamples([{ command: "skit author publish --version 1.0.0" }]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: {
      capabilities: [
        "filesystem.read",
        "filesystem.write",
        "network.read",
        "network.write",
        "process.execute",
      ],
      subprocesses: [...credentialStoreReadSubprocesses, ...workspaceSubprocesses],
    },
    outputSchemas: [outputContracts.publish],
    interactive: false,
  }),
  Command.provide(authorWorkspaceLayer),
);

const list = defineCommand(
  "list",
  {
    json: jsonFlag,
    registry: optionalString("registry", "Select a configured Registry alias or origin."),
  },
  (input) =>
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const home = (yield* SkitConfiguration).skitHome;
      const value = yield* authorListCommand({ ...input, home });
      yield* renderer.result(result("authorList", value));
    }),
).pipe(
  Command.withDescription("Experimental: list the SKITs you author on a Registry."),
  Command.withExamples([{ command: "skit author list" }]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: {
      capabilities: ["filesystem.read", "network.read", "process.execute"],
      subprocesses: credentialStoreReadSubprocesses,
    },
    outputSchemas: [outputContracts.authorList],
    interactive: false,
  }),
);

const remove = defineCommand(
  "delete",
  {
    destination: Argument.String("destination").pipe(
      Argument.withDescription("Private SKIT to delete: namespace/skit or a Registry URL."),
    ),
    json: jsonFlag,
    dryRun,
  },
  (input) =>
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const home = (yield* SkitConfiguration).skitHome;
      const value = yield* authorDeleteCommand(input.destination, {
        home,
        dryRun: input.dryRun,
      });
      yield* renderer.result(result("authorDelete", value));
    }),
).pipe(
  Command.withDescription(
    "Experimental: delete an owned private SKIT and its Registry history and releases.",
  ),
  Command.withExamples([{ command: "skit author delete me/my-skills --dry-run" }]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: {
      capabilities: ["filesystem.read", "network.read", "network.write", "process.execute"],
      subprocesses: credentialStoreReadSubprocesses,
    },
    outputSchemas: [outputContracts.authorDelete],
    interactive: false,
  }),
);

const invocation = defineCommand("invocation", { directory, json: jsonFlag, dryRun }, (input) =>
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    const value = yield* authorInvocationCommand(input.directory, input.dryRun);
    yield* renderer.result(
      result("authorInvocation", {
        path: value.root,
        dryRun: value.dryRun,
        generated: value.generated,
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Experimental: write declared invocation policies into authored Harness metadata.",
  ),
  Command.withExamples([{ command: "skit author invocation --dry-run" }]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [outputContracts.authorInvocation],
    interactive: false,
  }),
  Command.provide(authorWorkspaceLayer),
);

export const authorCliCommand = Command.make("author").pipe(
  Command.withDescription(
    "Experimental: initialize, validate, sync and publish authored skills. Commands and output formats may change between releases.",
  ),
  Command.withSubcommands([init, validate, sync, watch, publish, list, remove, invocation]),
);
