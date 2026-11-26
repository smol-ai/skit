import { commandTabHref } from "../src/route.ts";
import type { Atlas } from "../../src/atlas/data.ts";
import { Mounted as CardHover } from "../src/fluid/components/card/runtime";
import { Tabs as TabsPrimitive } from "@foldkit/ui";
import * as Scene from "foldkit/scene";
import { describe, it } from "vitest";
import { NavigateTo, ScrollToTop, update, view } from "../src/main.ts";
import { AtlasData, Message } from "../src/model.ts";
import { commandHref, flowHref, testHref } from "../src/route.ts";
import { atlas, loadedAt, urlAt } from "./fixture.ts";
import { settle } from "./settle.ts";

describe("a command's flows", () => {
  it("describes the whole journey and links to its recording", () => {
    const flow = {
      ...atlas.flows[0]!,
      name: "library/add-enable-remove",
      description:
        "Add a collection, enable its skills, then remove it while keeping the originals.",
      commands: ["add", "enable", "remove"],
    };
    Scene.scene(
      { update, view },
      Scene.given({
        ...loadedAt(commandTabHref("add", "flows")),
        atlas: AtlasData.Success({ data: { ...atlas, flows: [flow] } }),
      }),
      settle,
      Scene.expect(Scene.text(flow.description)).toExist(),
      Scene.expect(Scene.role("list", { name: "Recorded flows" })).toContainText(
        "Also runs: skit enable, skit remove",
      ),
      Scene.expect(Scene.text("3 steps")).toExist(),
      Scene.expect(Scene.role("link", { name: flow.description })).toHaveAttr(
        "href",
        flowHref(flow.name, 1),
      ),
    );
  });

  for (const status of ["passed", "failed", "skipped", "todo"] as const)
    it(`shows the matching saved ${status} result inside the flow link`, () => {
      const flow = { ...atlas.flows[0]!, commands: ["add"] };
      Scene.scene(
        { update, view },
        Scene.given({
          ...loadedAt(commandTabHref("add", "flows")),
          atlas: AtlasData.Success({
            data: {
              ...atlas,
              flows: [flow],
              testReports: [
                {
                  package: "cli",
                  startTime: 1000,
                  provenance: "current" as const,
                  files: [
                    {
                      file: "test/scenarios.ts",
                      tests: [
                        {
                          name: flow.name,
                          title: flow.name,
                          ancestorTitles: [],
                          status,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        }),
        settle,
        Scene.expect(Scene.role("link", { name: flow.description })).toContainText(status),
        Scene.expect(Scene.role("link", { name: flow.description })).toContainText(flow.name),
        Scene.expect(Scene.text("Open flow")).not.toExist(),
        Scene.expect(Scene.role("heading", { name: "Recordings" })).not.toExist(),
        Scene.expect(Scene.selector("a a")).not.toExist(),
        Scene.expect(Scene.selector("a button")).not.toExist(),
      );
    });

  it("names an existing fork parent and divergence step on the child row", () => {
    const parent = { ...atlas.flows[0]!, commands: ["add"] };
    const child = {
      ...parent,
      name: "child",
      description: "Another route",
      fork: { parent: parent.name, at: 2 },
    };
    Scene.scene(
      { update, view },
      Scene.given({
        ...loadedAt(commandTabHref("add", "flows")),
        atlas: AtlasData.Success({ data: { ...atlas, flows: [parent, child] } }),
      }),
      settle,
      Scene.expect(Scene.role("link", { name: child.description })).toContainText(
        `Branches from ${parent.name} after step 2`,
      ),
    );
  });
});

describe("a command's contract states", () => {
  it("shows output inline and keeps states without an example visible", () => {
    Scene.scene(
      { update, view },
      Scene.given({ ...loadedAt(commandTabHref("sync", "states")) }),
      settle,
      Scene.expectAll(Scene.all.selector('[data-slot="card"]')).toHaveCount(2),
      Scene.expect(Scene.role("group", { name: "library-sync/pushed" })).toExist(),
      Scene.expect(Scene.role("link", { name: "library-sync/pushed" })).toHaveAttr(
        "href",
        "#/stories/library-sync/pushed",
      ),
      Scene.expect(Scene.text("No output story records this state.")).toExist(),
      Scene.expect(Scene.text("1 result story, 2 named states, 2 flows.")).not.toExist(),
    );
  });
});

describe("a command's invocation", () => {
  it("shows arguments, option scopes, values, defaults and handler checks using the shared table", () => {
    const parameter = {
      name: "mode",
      aliases: ["-m"],
      type: "choice",
      description: "Select an import mode.",
      choices: ["fast", "safe"],
      required: false,
      repeated: false,
      min: 0,
      max: 1,
      default: { status: "value" as const, value: '"safe"' },
      missing: [],
    };
    const command = {
      ...atlas.commands[0]!,
      invocation: {
        usage: "skit add [flags] <source>",
        summary: "Add a source.",
        examples: ["skit add ./skills"],
        arguments: [
          {
            name: "source",
            aliases: [],
            type: "string",
            description: "Source to add.",
            required: true,
            repeated: false,
            min: 1,
            max: 1,
            default: { status: "none" as const },
            missing: [],
          },
        ],
        options: [
          { ...parameter, scope: "local" as const },
          { ...parameter, name: "home", scope: "inherited" as const },
          { ...parameter, name: "help", scope: "global" as const },
          {
            name: "version",
            aliases: ["-v"],
            type: "boolean",
            description: "Show version information",
            required: false,
            repeated: false,
            min: 0,
            max: 1,
            default: { status: "value" as const, value: "false" },
            missing: [],
            scope: "global" as const,
            shadowedTokens: ["--version"],
            beforeCommandExample: "skit --version add",
          },
        ],
        handlerRules: ["Review the selected source before applying it."],
        missing: [],
      },
    };
    Scene.scene(
      { update, view },
      Scene.given({
        ...loadedAt(commandHref("add")),
        atlas: AtlasData.Success({ data: { ...atlas, commands: [command] } }),
      }),
      settle,
      Scene.click(Scene.role("tab", { name: "Arguments & options" })),
      Scene.Command.resolve(TabsPrimitive.FocusTab, TabsPrimitive.Message.CompletedFocusTab()),
      Scene.Command.resolve(
        NavigateTo({ url: commandTabHref("add", "invocation") }),
        Message.CompletedNavigation(),
      ),
      Scene.Subscription.emit(
        Message.ChangedUrl({ url: urlAt(commandTabHref("add", "invocation")) }),
      ),
      Scene.Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
      Scene.Mount.expectEnded(CardHover),
      settle,
      Scene.expect(Scene.role("rowgroup", { name: "Arguments" })).toContainText("<source>"),
      Scene.expect(Scene.role("rowgroup", { name: "Command options" })).toContainText(
        "--mode <choice>",
      ),
      Scene.expect(Scene.role("rowgroup", { name: "Command options" })).toContainText(
        "fast | safe",
      ),
      Scene.expect(Scene.role("rowgroup", { name: "Command options" })).toContainText(
        'Parser default: "safe"',
      ),
      Scene.expect(Scene.role("rowgroup", { name: "Inherited options" })).toContainText("--home"),
      Scene.expect(Scene.role("rowgroup", { name: "Global options" })).toContainText("--help"),
      Scene.expect(Scene.role("rowgroup", { name: "Global options" })).toContainText(
        "uses the command option instead of the global option",
      ),
      Scene.expect(Scene.role("rowgroup", { name: "Global options" })).toContainText(
        "skit --version add",
      ),
      Scene.expect(Scene.text("Review the selected source before applying it.")).toExist(),
      Scene.expect(Scene.text("skit add ./skills")).toExist(),
    );
  });
});

it("states common invocation rules exactly and retains every deviation", () => {
  const parameter = {
    name: "mode",
    aliases: [],
    type: "choice",
    description: "Choose a mode.",
    required: false,
    repeated: false,
    min: 0,
    max: 1,
    default: { status: "none" as const },
    missing: [],
    scope: "local" as const,
  };
  const command = {
    ...atlas.commands[0]!,
    invocation: {
      ...atlas.commands[0]!.invocation,
      options: [
        { ...parameter, choices: ["fast", "safe"], valueName: "fast|safe" },
        { ...parameter, choices: ["fast", "safe"], name: "mismatch", valueName: "fast|unsafe" },
        {
          ...parameter,
          name: "tag",
          required: true,
          repeated: true,
          min: 1,
          max: 3,
          default: { status: "value" as const, value: "[]" },
        },
        {
          ...parameter,
          name: "toggle",
          type: "boolean",
          default: { status: "none" as const },
        },
        { ...parameter, name: "unknown", default: { status: "unavailable" as const } },
      ],
    },
  };
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt(commandTabHref("add", "invocation")),
      atlas: AtlasData.Success({ data: { ...atlas, commands: [command] } }),
    }),
    settle,
    Scene.expect(
      Scene.text(
        "Unless a row says otherwise, parameters are optional and accept one occurrence. Boolean options have a parser default of false; other parameters have no parser default.",
      ),
    ).toExist(),
    Scene.expect(Scene.role("row", { name: /--mode/ })).not.toContainText("Values:"),
    Scene.expect(Scene.role("row", { name: /--mismatch/ })).toContainText("Values: fast | safe"),
    Scene.expect(Scene.role("row", { name: /--tag/ })).toContainText("Required"),
    Scene.expect(Scene.role("row", { name: /--tag/ })).toContainText("1–3 occurrences"),
    Scene.expect(Scene.role("row", { name: /--tag/ })).toContainText("Parser default: []"),
    Scene.expect(Scene.role("row", { name: /--toggle/ })).toContainText("No parser default"),
    Scene.expect(Scene.role("row", { name: /--unknown/ })).toContainText(
      "Parser default unavailable",
    ),
  );
});

it("keeps nonzero story exits visible without repeating Exit 0", () => {
  const stories = [
    { ...atlas.stories[0]!, exitCode: 1 },
    { ...atlas.stories[1]!, exitCode: 0 },
  ];
  const command = { ...atlas.commands[0]!, stories: stories.map((story) => story.key) };
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt(commandTabHref("add", "results")),
      atlas: AtlasData.Success({ data: { ...atlas, commands: [command], stories } }),
    }),
    settle,
    Scene.expect(Scene.role("link", { name: "added, Exit 1" })).toContainText("Exit 1"),
    Scene.expect(Scene.text("Exit 0")).not.toExist(),
    Scene.expect(Scene.selector("a pre")).not.toExist(),
  );
});

describe("author command tests", () => {
  const watch = { ...atlas.commands[0]!, command: "author watch" };
  const data = {
    ...atlas,
    commands: [watch],
    flows: [{ ...atlas.flows[0]!, name: "author-watch/offline", commands: ["author watch"] }],
    testReports: [
      {
        package: "cli",
        startTime: 1794448800000,
        provenance: "current" as const,
        files: [
          {
            file: "packages/cli/test/scenario-sets.test.ts",
            tests: [
              {
                name: "skit author watch Edits are saved. author-watch/offline",
                title: "author-watch/offline",
                ancestorTitles: ["skit author watch", "Edits are saved."],
                status: "passed",
              },
              {
                name: "watch stops",
                title: "watch stops",
                ancestorTitles: ["skit author watch", "Edits are saved."],
                status: "todo",
              },
              {
                name: "failed edit",
                title: "failed edit",
                ancestorTitles: ["skit author watch", "Edits are saved."],
                status: "failed",
              },
              {
                name: "skipped edit",
                title: "skipped edit",
                ancestorTitles: ["skit author watch", "Edits are saved."],
                status: "skipped",
              },
              {
                name: "unrelated sync test",
                title: "unrelated sync test",
                ancestorTitles: [],
                status: "passed",
              },
            ],
          },
        ],
      },
    ],
  } satisfies Atlas;

  it("opens on the declared guarantee when neither package has a saved report", () => {
    const declarations = [
      {
        file: "watch.test.ts",
        tests: [
          { title: "writes offline", ancestorTitles: ["skit author watch", "Edits are saved."] },
        ],
      },
    ];
    Scene.scene(
      { update, view },
      Scene.given(
        update(
          loadedAt(commandHref("author watch")),
          Message.LoadedAtlas({
            atlas: { ...data, guaranteeFiles: declarations, testReports: [] },
          }),
        ).model,
      ),
      settle,
      Scene.expect(Scene.selector('[role="tab"][aria-selected="true"]')).toContainText(
        "Guarantees",
      ),
      Scene.click(Scene.role("button", { name: "Edits are saved. 1 test" })),
      Scene.expect(Scene.text("writes offline")).toExist(),
      Scene.expect(Scene.text("No current result")).toExist(),
    );
  });

  it("opens on guarantees, shows saved results and missing reports, and links scenarios to flows", () => {
    Scene.scene(
      { update, view },
      Scene.given(
        update(loadedAt(commandHref("author watch")), Message.LoadedAtlas({ atlas: data })).model,
      ),
      settle,
      Scene.expect(Scene.selector('[role="tab"][aria-selected="true"]')).toContainText(
        "Guarantees",
      ),
      Scene.expect(Scene.text("packages/cli/test/scenario-sets.test.ts")).toExist(),
      Scene.expect(Scene.text("packages/skit:")).toExist(),
      Scene.expect(Scene.text("No saved test report")).toExist(),
      Scene.expect(Scene.text("author-watch/offline")).toExist(),
      Scene.expect(Scene.text("unrelated sync test")).not.toExist(),
      Scene.expect(
        Scene.role("button", {
          name: "Edits are saved. 1 passed, 1 failed, 1 skipped, 1 todo",
        }),
      ).toHaveAttr("aria-expanded", "false"),
      Scene.click(
        Scene.role("button", {
          name: "Edits are saved. 1 passed, 1 failed, 1 skipped, 1 todo",
        }),
      ),
      Scene.expect(
        Scene.role("button", {
          name: "Edits are saved. 1 passed, 1 failed, 1 skipped, 1 todo",
        }),
      ).toHaveAttr("aria-expanded", "true"),
      Scene.expect(Scene.role("link", { name: data.flows[0]!.description })).toHaveAttr(
        "href",
        flowHref("author-watch/offline", 1),
      ),
      Scene.expect(Scene.role("link", { name: data.flows[0]!.description })).toContainText(
        "author-watch/offline",
      ),
      Scene.expect(Scene.role("link", { name: data.flows[0]!.description })).toContainText(
        "passed",
      ),
      Scene.expect(Scene.role("link", { name: "failed edit" })).not.toExist(),
      Scene.expect(Scene.role("link", { name: "skipped edit" })).not.toExist(),
      Scene.expect(Scene.role("img", { name: "Recorded flow" })).toExist(),
      Scene.expectAll(Scene.all.role("img", { name: "Test" })).toHaveCount(3),
    );
  });

  it("opens the exact test linked from a flow", () => {
    Scene.scene(
      { update, view },
      Scene.given(
        update(
          loadedAt(testHref("author watch", "author-watch/offline")),
          Message.LoadedAtlas({ atlas: data }),
        ).model,
      ),
      settle,
      Scene.expect(Scene.role("heading", { name: "author-watch/offline" })).toExist(),
      Scene.expect(
        Scene.role("button", {
          name: "Edits are saved. 1 passed, 1 failed, 1 skipped, 1 todo",
        }),
      ).toHaveAttr("aria-expanded", "true"),
      Scene.click(
        Scene.role("button", {
          name: "Edits are saved. 1 passed, 1 failed, 1 skipped, 1 todo",
        }),
      ),
      Scene.expect(
        Scene.role("button", {
          name: "Edits are saved. 1 passed, 1 failed, 1 skipped, 1 todo",
        }),
      ).toHaveAttr("aria-expanded", "false"),
      Scene.expect(Scene.text("watch stops")).not.toExist(),
      Scene.expect(Scene.role("link", { name: "All guarantees" })).toHaveAttr(
        "href",
        commandHref("author watch"),
      ),
    );
  });

  it("does not invent a Tests tab for a command without grouped evidence", () => {
    const command = { ...watch, command: "author sync" };
    Scene.scene(
      { update, view },
      Scene.given(
        update(
          loadedAt(commandHref(command.command)),
          Message.LoadedAtlas({ atlas: { ...data, commands: [command], testReports: [] } }),
        ).model,
      ),
      settle,
      Scene.expect(Scene.role("tab", { name: "Tests" })).not.toExist(),
      Scene.expect(Scene.role("tab", { name: "Guarantees" })).not.toExist(),
      Scene.expect(Scene.selector('[role="tab"][aria-selected="true"]')).toContainText("Results"),
    );
  });

  it("renders sections from ancestry and expands their guarantees independently", () => {
    const reports = [
      {
        package: "cli",
        startTime: 1000,
        provenance: "current" as const,
        files: [
          {
            file: "arbitrary.ts",
            tests: [
              {
                name: "one",
                title: "one",
                ancestorTitles: ["skit author watch", "First section", "First promise."],
                status: "passed" as const,
              },
              {
                name: "two",
                title: "two",
                ancestorTitles: ["skit author watch", "Second section", "Second promise."],
                status: "skipped" as const,
              },
            ],
          },
        ],
      },
    ];
    Scene.scene(
      { update, view },
      Scene.given(
        update(
          loadedAt(commandHref("author watch")),
          Message.LoadedAtlas({ atlas: { ...data, testReports: reports } }),
        ).model,
      ),
      settle,
      Scene.expect(Scene.role("heading", { name: "First section" })).toExist(),
      Scene.expect(Scene.role("heading", { name: "Second section" })).toExist(),
      Scene.expect(Scene.role("tab", { name: "Tests" })).not.toExist(),
      Scene.click(Scene.role("button", { name: "Second promise. 1 skipped" })),
      Scene.expect(Scene.role("button", { name: "Second promise. 1 skipped" })).toHaveAttr(
        "aria-expanded",
        "true",
      ),
      Scene.expect(Scene.role("button", { name: "First promise. 1 passed" })).toHaveAttr(
        "aria-expanded",
        "false",
      ),
      Scene.click(Scene.role("button", { name: "First promise. 1 passed" })),
      Scene.expect(Scene.role("button", { name: "First promise. 1 passed" })).toHaveAttr(
        "aria-expanded",
        "true",
      ),
      Scene.expect(Scene.role("button", { name: "Second promise. 1 skipped" })).toHaveAttr(
        "aria-expanded",
        "true",
      ),
    );
  });

  it("names each source file once and keeps its tests under that file", () => {
    const file = "packages/skit/test/shared-sync.test.ts";
    const extra = {
      name: "core check",
      title: "core check",
      ancestorTitles: ["skit author watch", "Edits are saved."],
      status: "passed" as const,
    };
    Scene.scene(
      { update, view },
      Scene.given(
        update(
          loadedAt(commandHref("author watch")),
          Message.LoadedAtlas({
            atlas: {
              ...data,
              testReports: [
                ...data.testReports,
                {
                  package: "skit",
                  startTime: 1000,
                  provenance: "current" as const,
                  files: [{ file, tests: [extra] }],
                },
              ],
            },
          }),
        ).model,
      ),
      settle,
      Scene.expect(Scene.role("list", { name: `Tests in ${file}` })).toContainText("core check"),
      Scene.expect(
        Scene.role("list", { name: "Tests in packages/cli/test/scenario-sets.test.ts" }),
      ).not.toContainText("core check"),
      Scene.expectAll(Scene.all.text(file)).toHaveCount(1),
    );
  });

  it("shows every rendered example for a schema event", () => {
    const event = { state: "watching", stories: ["add/added", "library-sync/pushed"] };
    Scene.scene(
      { update, view },
      Scene.given({
        ...loadedAt(commandTabHref("author watch", "results")),
        atlas: AtlasData.Success({
          data: {
            ...data,
            commands: [{ ...watch, contracts: ["authorWatch"] }],
            contracts: [
              { contract: "authorWatch", field: "event", states: [event], stories: event.stories },
            ],
          },
        }),
      }),
      settle,
      Scene.expect(Scene.text("Events")).toExist(),
      Scene.expectAll(Scene.all.selector('[data-slot="card"]')).toHaveCount(2),
      Scene.expect(Scene.role("link", { name: "add/added" })).toExist(),
      Scene.expect(Scene.selector('a[href="#/stories/library-sync/pushed"]')).toExist(),
    );
  });
});

for (const tab of ["unknown", "guarantees"])
  it(`uses Not found for the unavailable add tab ${tab}`, () => {
    Scene.scene(
      { update, view },
      Scene.given(loadedAt(`#/commands/add/tabs/${tab}`)),
      settle,
      Scene.expect(Scene.role("heading", { name: "Not in the Atlas" })).toExist(),
      Scene.expect(Scene.role("tablist", { name: "Command details" })).not.toExist(),
    );
  });
