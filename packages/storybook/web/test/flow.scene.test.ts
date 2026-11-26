import * as Scene from "foldkit/scene";
import { expect, it } from "vitest";
import { AtlasData } from "../src/model.ts";
import { update, view } from "../src/main.ts";
import { flowHref, testHref } from "../src/route.ts";
import { stepKind, stepLabel } from "../src/pages/flow.ts";
import { atlas, loadedAt } from "./fixture.ts";
import { settle } from "./settle.ts";

const base = atlas.flows[0]!;
const flow = {
  name: base.name,
  description: base.description,
  commands: base.commands,
  _tag: "Scenario" as const,
  world: { registryOnline: true },
  worldLabels: { registryOnline: "Registry is online" },
  terminalDevice: "a",
  steps: base.steps,
  evidence: "Fixture evidence retained verbatim.",
};

it("puts replay controls first and folds the source world and evidence without inventing a status", () => {
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt(flowHref(flow.name, 2)),
      atlas: AtlasData.Success({ data: { ...atlas, flows: [flow] } }),
    }),
    settle,
    Scene.expect(Scene.role("heading", { level: 1, name: flow.description })).toExist(),
    Scene.expect(Scene.text("Device a")).toExist(),
    Scene.expect(Scene.text("2 of 3")).toExist(),
    Scene.expect(Scene.role("link", { name: /Saved test/ })).not.toExist(),
    Scene.expect(Scene.role("heading", { name: "Test" })).not.toExist(),
    Scene.expect(Scene.role("button", { name: "Recording setup and evidence" })).toHaveAttr(
      "aria-expanded",
      "false",
    ),
    Scene.click(Scene.role("button", { name: "Recording setup and evidence" })),
    Scene.expect(Scene.role("button", { name: "Recording setup and evidence" })).toHaveAttr(
      "aria-expanded",
      "true",
    ),
    Scene.expect(Scene.text("Registry is online")).toExist(),
    Scene.expect(Scene.text(flow.evidence)).toExist(),
    Scene.expect(Scene.selector('a[aria-current="step"]')).toHaveAttr(
      "href",
      flowHref(flow.name, 2),
    ),
  );
});

it("links a real saved status to the command identified by its test ancestry", () => {
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt(flowHref(flow.name, 1)),
      atlas: AtlasData.Success({
        data: {
          ...atlas,
          flows: [flow],
          testReports: [
            {
              package: "cli",
              startTime: 1000,
              provenance: "current",
              files: [
                {
                  file: "arbitrary.ts",
                  tests: [
                    {
                      name: flow.name,
                      title: flow.name,
                      ancestorTitles: ["skit evidence owner", "Section", "Promise"],
                      status: "skipped",
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
    Scene.expect(Scene.role("link", { name: "Saved test skipped; open guarantee" })).toHaveAttr(
      "href",
      testHref("evidence owner", flow.name),
    ),
    Scene.expect(Scene.role("link", { name: "Saved test skipped; open guarantee" })).toContainText(
      "skipped",
    ),
  );
});

it("labels structured results and answers without slicing display text or mislabelling notes as commands", () => {
  const step = {
    kind: "step" as const,
    frame: "a.json",
    issues: [],
    label: "This is not a prefix to parse",
  };
  expect(stepKind({ ...step, event: "Command", command: "skit doctor" })).toBe("command");
  expect(stepLabel({ ...step, event: "Command", command: "skit doctor" })).toBe("skit doctor");
  expect(stepKind({ ...step, event: "Failure" })).toBe("failure");
  expect(stepKind({ ...step, event: "Instruction" })).toBe("instruction");
  expect(stepKind(step)).toBe("step");
  expect(
    stepLabel({ ...step, outcome: { contract: "watch", state: "retrying", others: [] } }),
  ).toBe("retrying");
  expect(
    stepLabel({ ...step, answer: { kind: "confirm", offered: ["yes", "no"], chosen: ["no"] } }),
  ).toBe("no");
});
