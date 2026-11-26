import { commandTabHref } from "../src/route.ts";
import * as Scene from "foldkit/scene";
import { expect, it } from "vitest";
import type { Step } from "../../src/atlas/data.ts";
import { AtlasData } from "../src/model.ts";
import { update, view } from "../src/main.ts";
import { stepGroups } from "../src/pages/flow.ts";
import { routeOf, flowHref } from "../src/route.ts";
import { atlas, loadedAt, urlAt } from "./fixture.ts";
import { settle } from "./settle.ts";

it("groups the flow index by command and links readable recording titles", () => {
  expect(routeOf(urlAt("#/flows"))).toEqual({ _tag: "Flows" });
  Scene.scene(
    { update, view },
    Scene.given(loadedAt("#/flows")),
    settle,
    Scene.expect(Scene.role("heading", { level: 1, name: "Flows" })).toExist(),
    Scene.expect(Scene.role("link", { name: atlas.flows[1]!.description })).toHaveAttr(
      "href",
      flowHref("library-sync/download-failed", 1),
    ),
    Scene.expect(Scene.text(atlas.flows[1]!.description)).toExist(),
    Scene.expect(Scene.role("heading", { name: "skit sync" })).toExist(),
    Scene.expect(Scene.selector("article h2 a")).toHaveAttr(
      "href",
      commandTabHref("sync", "flows"),
    ),
    Scene.expect(Scene.text("Starting world")).not.toExist(),
    Scene.expect(Scene.selector("a a")).not.toExist(),
  );
  Scene.scene(
    { update, view },
    Scene.given(loadedAt(flowHref(atlas.flows[0]!.name, 1))),
    settle,
    Scene.expect(Scene.text(atlas.flows[0]!.description)).toExist(),
  );
});

it("keeps coverage on its own page and explains commands on the overview", () => {
  Scene.scene(
    { update, view },
    Scene.given(loadedAt("#/")),
    settle,
    Scene.expect(Scene.role("heading", { name: "How SKIT works" })).toExist(),
    Scene.expect(Scene.text("Add a source.")).toExist(),
    Scene.expect(Scene.text("commands in a flow")).not.toExist(),
  );
  Scene.scene(
    { update, view },
    Scene.given(loadedAt("#/coverage")),
    settle,
    Scene.expect(Scene.role("heading", { level: 1, name: "Atlas coverage" })).toExist(),
    Scene.expect(Scene.text("commands in a flow")).toExist(),
  );
});

it("groups adjacent progress ticks while keeping prompts, answers and results separate", () => {
  const step = (kind: Step["kind"], progress?: string): { step: Step } => ({
    step: { kind, progress, label: kind, issues: [], frame: `${kind}.json` },
  });
  expect(
    stepGroups([
      step("step"),
      step("progress", "Downloading"),
      step("progress", "Downloading"),
      step("prompt"),
      step("answer"),
      step("progress", "Downloading"),
      step("result"),
    ]),
  ).toEqual([
    { start: 0, end: 0 },
    { start: 1, end: 2 },
    { start: 3, end: 3 },
    { start: 4, end: 4 },
    { start: 5, end: 5 },
    { start: 6, end: 6 },
  ]);
});

it("keeps reviewed gaps beside flow rows without duplicating the recorded inventory", () => {
  const data = {
    ...atlas,
    commands: atlas.commands.map((command) =>
      command.command === "sync"
        ? {
            ...command,
            scenarios: [
              {
                name: "fresh-device",
                description: "Install on a new device.",
                flow: atlas.flows[0]!.name,
              },
              { name: "stale-plan", description: "State changes before apply." },
            ],
          }
        : command,
    ),
  };
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt("#/commands/sync/tabs/flows"),
      atlas: AtlasData.Success({ data }),
    }),
    settle,
    Scene.expect(Scene.role("heading", { name: "Not yet recorded" })).toExist(),
    Scene.expect(Scene.text("stale-plan")).toExist(),
    Scene.expect(Scene.role("link", { name: atlas.flows[0]!.description })).toHaveAttr(
      "href",
      flowHref(atlas.flows[0]!.name, 1),
    ),
  );
  Scene.scene(
    { update, view },
    Scene.given({ ...loadedAt("#/commands/add/tabs/flows") }),
    settle,
    Scene.expect(
      Scene.text(
        "This command’s scenario inventory has not been reviewed. Existing recordings demonstrate only the paths they describe.",
      ),
    ).not.toExist(),
  );
});

it("explains author lifecycle and distinguishes branch recordings from isolated output examples", () => {
  const data = {
    ...atlas,
    commands: atlas.commands.map((command) =>
      command.command === "author sync"
        ? {
            ...command,
            contracts: ["sync"],
            details: [
              {
                title: "Durable sync checkpoint",
                body: "Writing resumes newer local edits after interruption.",
                source: "packages/skit/src/sync/sync.ts",
              },
            ],
            scenarios: [
              {
                name: "writing-recovery",
                description: "Resume a partial application.",
                flow: atlas.flows[0]!.name,
              },
              {
                name: "broken-backup-ancestry",
                description: "Refuse a disconnected backup chain.",
              },
            ],
          }
        : command,
    ),
    contracts: [
      {
        contract: "sync",
        field: "status" as const,
        states: [{ state: "ready", stories: [] }],
        stories: [],
        variants: [
          {
            state: "ready",
            field: "action",
            value: "pull",
            stories: [],
            recordings: [{ flow: atlas.flows[0]!.name, step: 2 }],
          },
          { state: "ready", field: "action", value: "merge", stories: [], recordings: [] },
        ],
      },
    ],
  };
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt(commandTabHref("author sync", "flows")),
      atlas: AtlasData.Success({ data }),
    }),
    settle,
    Scene.expect(Scene.role("heading", { name: "Durable sync checkpoint" })).toExist(),
    Scene.expect(Scene.text("broken-backup-ancestry")).toExist(),
  );
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt(commandTabHref("sync", "states")),
      atlas: AtlasData.Success({
        data: {
          ...data,
          commands: data.commands.map((command) =>
            command.command === "sync" ? { ...command, contracts: ["sync"] } : command,
          ),
        },
      }),
    }),
    settle,
    Scene.expect(Scene.text("action: pull")).toExist(),
    Scene.expect(Scene.role("link", { name: `Recorded: ${atlas.flows[0]!.name}` })).toHaveAttr(
      "href",
      flowHref(atlas.flows[0]!.name, 2),
    ),
    Scene.expect(Scene.text("No recorded workflow for this branch.", { exact: false })).toExist(),
  );
});
