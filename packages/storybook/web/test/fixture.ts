import { Option } from "effect";
import type { Url } from "foldkit";
import type { Atlas, Frame } from "../../src/atlas/data.ts";
import { init } from "../src/main.ts";
import { AtlasData, FrameData, type Model } from "../src/model.ts";
import { routeOf } from "../src/route.ts";

const step = (label: string, frame: string) => ({
  kind: "step" as const,
  label,
  frame,
  issues: [],
});

/** A small Atlas: three commands, two stories and a flow with one fork. */
export const atlas: Atlas = {
  systemMap: {
    sourceFingerprint: "fixture",
    services: [],
    commands: [],
    stops: [],
    elapsedMs: 0,
    compiler: {
      typescript: "fixture",
      tsrs: "fixture",
      typescriptCommit: "fixture",
      fingerprint: "fixture",
    },
  },
  testReports: [],
  persistence: [],
  vocabulary: [],
  verbs: [],
  errors: [],
  commands: [
    {
      command: "add",
      invocation: {
        handlerRules: [],
        usage: "skit add [flags] <source>",
        summary: "Add a source.",
        examples: [],
        arguments: [],
        options: [],
        missing: [],
      },
      errors: [],
      dependencyErrors: [],
      interactive: false,
      contracts: ["add"],
      stories: ["add/added"],
    },
    {
      command: "author sync",
      invocation: {
        handlerRules: [],
        usage: "skit author sync [flags]",
        summary: "Sync authored skills.",
        examples: [],
        arguments: [],
        options: [],
        missing: [],
      },
      errors: [],
      dependencyErrors: [],
      interactive: false,
      contracts: [],
      stories: [],
    },
    {
      command: "sync",
      invocation: {
        handlerRules: [],
        usage: "skit sync [flags]",
        summary: "Sync the Library.",
        examples: [],
        arguments: [],
        options: [],
        missing: [],
      },
      errors: [],
      dependencyErrors: [],
      interactive: false,
      contracts: ["librarySync"],
      stories: ["library-sync/pushed"],
    },
  ],
  contracts: [
    { contract: "add", states: [], stories: ["add/added"] },
    {
      contract: "librarySync",
      field: "status",
      states: [
        { state: "pushed", stories: ["library-sync/pushed"] },
        { state: "conflicted", stories: [] },
      ],
      stories: ["library-sync/pushed"],
    },
  ],
  stories: [
    {
      key: "add/added",
      errorTags: [],
      text: "",
      issues: [],
      color: "frames/stories/add/added.json",
      plain: "frames/stories/add/added.plain.json",
    },
    {
      key: "library-sync/pushed",
      errorTags: [],
      text: "",
      issues: [
        { kind: "term", text: "Retired", verb: "retire" },
        { kind: "code", text: "STORAGE_FAILURE" },
      ],
      color: "frames/stories/library-sync/pushed.json",
      plain: "frames/stories/library-sync/pushed.plain.json",
    },
  ],
  flows: [
    {
      name: "library-sync/fresh-device",
      description: "Install enabled skills on a fresh device.",
      _tag: "Journey",
      initialState: "Empty device",
      finalState: "Pushed",
      commands: ["sync"],
      steps: [
        step("$ skit sync --apply", "frames/flows/library-sync/fresh-device/1.json"),
        step("Downloading", "frames/flows/library-sync/fresh-device/2.json"),
        {
          ...step("Pushed", "frames/flows/library-sync/fresh-device/3.json"),
          issues: [{ kind: "code", text: "STORAGE_FAILURE" }],
          outcome: {
            contract: "librarySync",
            state: "pushed",
            others: [{ state: "conflicted" }],
          },
        },
      ],
    },
    {
      name: "library-sync/download-failed",
      description: "Show a failed download during sync.",
      _tag: "Journey",
      initialState: "Empty device",
      finalState: "Failed",
      commands: ["sync"],
      fork: { parent: "library-sync/fresh-device", at: 2 },
      steps: [step("Failed", "frames/flows/library-sync/download-failed/3.json")],
    },
  ],
  frames: [],
  blocks: [],
};

/** A step that runs into a copy issue while its status line spins. */
export const runningFrame: Frame = {
  rows: [
    { runs: [{ text: "$ skit sync --apply", dim: true }] },
    {
      runs: [
        { text: "✓", foreground: 2 },
        { text: " " },
        { text: "Retired", bold: true },
        { text: " 2 copies" },
      ],
      issues: [{ start: 2, end: 9, issue: { kind: "term", text: "Retired", verb: "retire" } }],
    },
  ],
  status: { spinner: ["⠋", "⠙"], interval: 80, row: { runs: [{ text: "Downloading" }] } },
};

const paths = [
  ...atlas.stories.flatMap((story) => [story.color, story.plain]),
  ...atlas.flows.flatMap((flow) => flow.steps.map((step) => step.frame)),
];

/** The URL the Atlas has open at a hash such as `#/commands/add`. */
export const urlAt = (hash: string): Url.Url => ({
  protocol: "http:",
  host: "127.0.0.1",
  port: Option.some("5173"),
  pathname: "/",
  search: Option.none(),
  hash: Option.some(hash.replace(/^#/, "")),
});

/** The Atlas loaded and open at `hash`, with every frame loaded. */
export const loadedAt = (hash: string): Model => ({
  ...init(urlAt(hash)).model,
  route: routeOf(urlAt(hash)),
  atlas: AtlasData.Success({ data: atlas }),
  frames: Object.fromEntries(
    paths.map((path) => [path, FrameData.Success({ data: runningFrame })]),
  ),
});
