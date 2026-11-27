import { Guarantee } from "./guarantee-metadata.ts";
import { Schema } from "effect";

/**
 * The Atlas index: what the generator writes as `atlas.json` and the Atlas app decodes. Every
 * terminal frame is a separate `Frame` file; fields holding one are paths relative to the index.
 */

/** Words a person should not have to read: internal identifiers, raw codes and avoided verbs. */
export const CopyIssue = Schema.Struct({
  kind: Schema.Literals(["ID", "hash", "code", "term"]),
  text: Schema.String,
  /** For a term: the verb CONTEXT.md says to avoid that it is a form of. */
  verb: Schema.optionalKey(Schema.String),
});
export type CopyIssue = typeof CopyIssue.Type;

/**
 * A terminal colour as the CLI named it, so the app can theme it: an ANSI palette index
 * (0 to 15 for the named colours, up to 255), or an RGB hex. A run without one uses the default.
 */
const Color = Schema.Union([Schema.Int, Schema.String]);

/** Text with one style. A row's runs follow each other with no gaps. */
const Run = Schema.Struct({
  text: Schema.String,
  foreground: Schema.optionalKey(Color),
  background: Schema.optionalKey(Color),
  /** Foreground and background swap. */
  inverse: Schema.optionalKey(Schema.Boolean),
  bold: Schema.optionalKey(Schema.Boolean),
  dim: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  underline: Schema.optionalKey(Schema.Boolean),
});

/** A copy issue on a row: columns `start` up to `end`. An issue the terminal wrapped covers two rows. */
const Mark = Schema.Struct({ start: Schema.Int, end: Schema.Int, issue: CopyIssue });

/** One terminal row, as the terminal wrapped it at the frame's width. */
export const Row = Schema.Struct({
  runs: Schema.Array(Run),
  issues: Schema.optionalKey(Schema.Array(Mark)),
});
export type Row = typeof Row.Type;

/** A terminal frame: its rows, then the status line a running step shows below them. */
export const Frame = Schema.Struct({
  rows: Schema.Array(Row),
  status: Schema.optionalKey(
    Schema.Struct({
      /** The spinner's glyphs, shown in turn every `interval` milliseconds. */
      spinner: Schema.Array(Schema.String),
      interval: Schema.Int,
      row: Row,
    }),
  ),
});
export type Frame = typeof Frame.Type;

export const Step = Schema.Struct({
  event: Schema.optionalKey(
    Schema.Literals([
      "Command",
      "StatusStarted",
      "StatusUpdated",
      "StatusEnded",
      "Note",
      "Instruction",
      "Step",
      "PromptShown",
      "PromptAnswered",
      "Result",
      "Failure",
      "Help",
    ]),
  ),
  command: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["step", "progress", "prompt", "answer", "result"]),
  progress: Schema.optionalKey(Schema.String),
  label: Schema.String,
  frame: Schema.String,
  /** Copy problems this step shows for the first time in its journey. */
  issues: Schema.Array(CopyIssue),
  /** A result step, with the states its contract could have reported instead. */
  outcome: Schema.optionalKey(
    Schema.Struct({
      contract: Schema.String,
      variants: Schema.optionalKey(
        Schema.Array(Schema.Struct({ field: Schema.String, value: Schema.String })),
      ),
      state: Schema.optionalKey(Schema.String),
      others: Schema.Array(
        Schema.Struct({ state: Schema.String, story: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
  /** An answered prompt: the visible choices it offered and the ones the script took. */
  answer: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literals([
        "select",
        "autocomplete",
        "multiselect",
        "confirm",
        "text",
        "password",
      ]),
      offered: Schema.Array(Schema.String),
      chosen: Schema.Array(Schema.String),
    }),
  ),
});
export type Step = typeof Step.Type;

const flowFields = {
  evidence: Schema.optionalKey(Schema.String),
  name: Schema.String,
  description: Schema.String,
  /** The commands the flow runs, in the order it first runs them. */
  commands: Schema.Array(Schema.String),
  /** Set when the flow repeats the first `at` steps of the `parent` flow; `steps` start after them. */
  fork: Schema.optionalKey(Schema.Struct({ parent: Schema.String, at: Schema.Int })),
  steps: Schema.Array(Step),
};
const Flow = Schema.TaggedUnion({
  Journey: { ...flowFields, initialState: Schema.String, finalState: Schema.String },
  Scenario: {
    ...flowFields,
    world: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
    ),
    worldLabels: Schema.Record(Schema.String, Schema.String),
    terminalDevice: Schema.String,
  },
});

const InvocationParameter = Schema.Struct({
  name: Schema.String,
  aliases: Schema.Array(Schema.String),
  type: Schema.String,
  valueName: Schema.optionalKey(Schema.String),
  description: Schema.String,
  required: Schema.Boolean,
  repeated: Schema.Boolean,
  min: Schema.Int,
  max: Schema.optionalKey(Schema.Int),
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
  negation: Schema.optionalKey(Schema.String),
  optionalValue: Schema.optionalKey(Schema.String),
  shadowedTokens: Schema.optionalKey(Schema.Array(Schema.String)),
  beforeCommandExample: Schema.optionalKey(Schema.String),
  globalKind: Schema.optionalKey(Schema.Literals(["action", "setting"])),
  default: Schema.Struct({
    status: Schema.Literals(["none", "value", "unavailable"]),
    value: Schema.optionalKey(Schema.String),
  }),
  missing: Schema.Array(Schema.String),
});
const CommandInvocation = Schema.Struct({
  handlerRules: Schema.Array(Schema.String),
  usage: Schema.String,
  summary: Schema.String,
  examples: Schema.Array(Schema.String),
  arguments: Schema.Array(InvocationParameter),
  options: Schema.Array(
    Schema.Struct({
      ...InvocationParameter.fields,
      scope: Schema.Literals(["local", "inherited", "global"]),
    }),
  ),
  missing: Schema.Array(Schema.String),
});

const Command = Schema.Struct({
  command: Schema.String,
  invocation: CommandInvocation,
  details: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ title: Schema.String, body: Schema.String, source: Schema.String }),
    ),
  ),
  scenarios: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        flow: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  /** Source-qualified error definitions in this command’s checked error type. */
  errors: Schema.Array(Schema.String),
  dependencyErrors: Schema.Array(Schema.String),
  interactive: Schema.Boolean,
  /** The result contracts the command declares. */
  contracts: Schema.Array(Schema.String),
  /** Output stories that show any of those contracts. */
  stories: Schema.Array(Schema.String),
});

const Contract = Schema.Struct({
  variants: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        state: Schema.String,
        field: Schema.String,
        value: Schema.String,
        stories: Schema.Array(Schema.String),
        recordings: Schema.optionalKey(
          Schema.Array(Schema.Struct({ flow: Schema.String, step: Schema.Int })),
        ),
      }),
    ),
  ),
  contract: Schema.String,
  /** The field that names the contract's states; absent when the contract has a single state. */
  field: Schema.optionalKey(Schema.Literals(["status", "event", "action"])),
  states: Schema.Array(
    Schema.Struct({ state: Schema.String, stories: Schema.Array(Schema.String) }),
  ),
  stories: Schema.Array(Schema.String),
});

const Story = Schema.Struct({
  errorTags: Schema.Array(Schema.String),
  /** Plain output from the real presenter, also used for message search. */
  text: Schema.String,
  key: Schema.String,
  scenario: Schema.optionalKey(
    Schema.Struct({ initial: Schema.String, trigger: Schema.String, result: Schema.String }),
  ),
  exitCode: Schema.optionalKey(Schema.Int),
  /** Copy problems the story shows, in order of appearance. */
  issues: Schema.Array(CopyIssue),
  color: Schema.String,
  plain: Schema.String,
});

/** A Block or frame example, with and without colour. */
const Example = Schema.Struct({
  name: Schema.String,
  width: Schema.Int,
  color: Schema.String,
  plain: Schema.String,
});

const ErrorCategory = Schema.Literals([
  "Input validation",
  "Operational failure",
  "Internal defect",
  "Mixed use",
  "Stored format conversion",
  "Unclassified",
]);

export const ErrorDefinition = Schema.Struct({
  category: ErrorCategory,
  evidence: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals([
        "Checked failure",
        "Checked interface",
        "Defect",
        "Throw",
        "Stored conversion",
        "Construction",
      ]),
      file: Schema.String,
      line: Schema.Int,
      source: Schema.String,
    }),
  ),
  tag: Schema.String,
  name: Schema.String,
  file: Schema.String,
  line: Schema.Int,
  definition: Schema.String,
  services: Schema.Array(Schema.String),
  presentations: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      source: Schema.String,
    }),
  ),
});
export type ErrorDefinition = typeof ErrorDefinition.Type;

/** A persisted format and the source definitions that describe its on-disk representation. */
export const PersistedStore = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scope: Schema.Literals(["Device", "Workspace", "Registry"]),
  format: Schema.String,
  paths: Schema.Array(Schema.String),
  owner: Schema.String,
  owners: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      file: Schema.String,
      line: Schema.Int,
      source: Schema.String,
      errors: Schema.Array(Schema.String),
    }),
  ),
  description: Schema.String,
  definitions: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      file: Schema.String,
      line: Schema.Int,
      source: Schema.String,
    }),
  ),
});
export type PersistedStore = typeof PersistedStore.Type;

/** Every dependency claim keeps its declaration or use-site anchor. */
export const MapSource = Schema.Struct({ file: Schema.String, line: Schema.Int });
export const MapStop = Schema.Struct({ ...MapSource.fields, reason: Schema.String });
export const MapMember = Schema.Struct({
  ...MapSource.fields,
  key: Schema.String,
  name: Schema.String,
  declarations: Schema.Array(Schema.String),
  incomplete: Schema.Boolean,
  service: Schema.optionalKey(Schema.String),
});
export const MapProvider = Schema.Struct({
  ...MapSource.fields,
  name: Schema.String,
  requires: Schema.Array(MapMember),
  incomplete: Schema.Boolean,
  notes: Schema.Array(Schema.String),
});
export const ServiceDefinition = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  ...MapSource.fields,
  id: Schema.String,
  name: Schema.String,
  identifier: Schema.String,
  kind: Schema.String,
  operations: Schema.Array(
    Schema.Struct({ ...MapSource.fields, name: Schema.String, signature: Schema.String }),
  ),
  providers: Schema.Array(MapProvider),
  stores: Schema.Array(Schema.String),
});
const TracedProvider = Schema.Struct({
  ...MapProvider.fields,
  dependencies: Schema.Array(Schema.String),
});
export const RequirementTrace = Schema.Struct({
  ...MapMember.fields,
  id: Schema.String,
  providers: Schema.Array(TracedProvider),
  candidates: Schema.Array(TracedProvider),
  stops: Schema.Array(MapStop),
});
const CommandRequirements = Schema.Struct({
  command: Schema.String,
  sources: Schema.Array(MapSource),
  requirements: Schema.Array(RequirementTrace),
  traces: Schema.Array(RequirementTrace),
  application: Schema.Array(Schema.Struct({ ...MapSource.fields, name: Schema.String })),
  incompleteErrors: Schema.Boolean,
  notes: Schema.Array(Schema.String),
  stores: Schema.Array(Schema.String),
  stops: Schema.Array(MapStop),
});
export const SystemMap = Schema.Struct({
  sourceFingerprint: Schema.String,
  services: Schema.Array(ServiceDefinition),
  commands: Schema.Array(CommandRequirements),
  stops: Schema.Array(MapStop),
  elapsedMs: Schema.Finite,
  compiler: Schema.Struct({
    typescript: Schema.String,
    tsrs: Schema.String,
    typescriptCommit: Schema.String,
    fingerprint: Schema.String,
  }),
});
export type SystemMap = typeof SystemMap.Type;

export const Atlas = Schema.Struct({
  systemMap: SystemMap,
  guaranteeFiles: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        file: Schema.String,
        unattached: Schema.optionalKey(Schema.Int),
        tests: Schema.Array(
          Schema.Struct({
            title: Schema.String,
            ancestorTitles: Schema.Array(Schema.String),
            guarantee: Schema.optionalKey(Guarantee),
          }),
        ),
      }),
    ),
  ),
  testReports: Schema.Array(
    Schema.Struct({
      package: Schema.String,
      startTime: Schema.Finite,
      source: Schema.optionalKey(Schema.Struct({ revision: Schema.String, dirty: Schema.Boolean })),
      provenance: Schema.Literals(["current", "stale", "unverified"]),
      files: Schema.Array(
        Schema.Struct({
          file: Schema.String,
          tests: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              title: Schema.String,
              ancestorTitles: Schema.Array(Schema.String),
              guarantee: Schema.optionalKey(Guarantee),
              status: Schema.Literals(["passed", "failed", "skipped", "todo"]),
            }),
          ),
        }),
      ),
    }),
  ),
  vocabulary: Schema.Array(
    Schema.Struct({
      group: Schema.String,
      term: Schema.String,
      meaning: Schema.String,
      avoid: Schema.String,
    }),
  ),
  verbs: Schema.Array(Schema.Struct({ verb: Schema.String, meaning: Schema.String })),
  persistence: Schema.Array(PersistedStore),
  errors: Schema.Array(ErrorDefinition),
  commands: Schema.Array(Command),
  contracts: Schema.Array(Contract),
  stories: Schema.Array(Story),
  /** Ordered as a tree: a fork follows the flow it leaves. */
  flows: Schema.Array(Flow),
  /** What the CLI draws around output. */
  frames: Schema.Array(Example),
  /** The Block vocabulary. */
  blocks: Schema.Array(Example),
});
export type Atlas = typeof Atlas.Type;
