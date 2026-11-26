import {
  outputStories,
  renderOutputFrame,
  defaultTerminalEnvironment,
} from "@smolai/skit/storybook";
import * as Scene from "foldkit/scene";
import { expect, it } from "vitest";
import { framesOn, update, view } from "../src/main.ts";
import { AtlasData, FrameData } from "../src/model.ts";
import { errorHref, routeOf } from "../src/route.ts";
import { atlas, loadedAt, urlAt } from "./fixture.ts";
import { settle } from "./settle.ts";

const error = {
  category: "Operational failure" as const,
  evidence: [
    {
      kind: "Checked failure" as const,
      file: "packages/skit/src/writer.ts",
      line: 24,
      source: "yield* new WriterBusy()",
    },
  ],
  name: "WriterBusy",
  tag: "WriterBusy",
  file: "packages/skit/src/writer.ts",
  line: 12,
  definition: "class WriterBusy { path: string }",
  services: ["Writer"],
  presentations: [
    {
      file: "packages/cli/src/writer-failures.ts",
      source: "formatter code",
    },
  ],
};
const data = {
  ...atlas,
  errors: [
    error,
    { ...error, name: "OtherFailure", tag: "OtherFailure", services: [], presentations: [] },
  ],
};
const loaded = (href: string) => ({ ...loadedAt(href), atlas: AtlasData.Success({ data }) });

it("searches user-facing text and keeps errors with no dedicated presentation visible", () => {
  Scene.scene(
    { update, view },
    Scene.given({
      ...loaded("#/errors"),
      atlas: AtlasData.Success({
        data: {
          ...data,
          stories: [
            {
              ...atlas.stories[0]!,
              errorTags: [error.tag],
              text: "Retry after the other writer finishes.",
            },
          ],
        },
      }),
    }),
    settle,
    Scene.expect(Scene.role("link", { name: "WriterBusy" })).toExist(),
    Scene.expect(Scene.role("link", { name: "OtherFailure" })).toExist(),
    Scene.type(Scene.role("searchbox", { name: "Search errors" }), "other writer finishes"),
    settle,
    Scene.expect(Scene.role("link", { name: "WriterBusy" })).toExist(),
    Scene.expect(Scene.role("link", { name: "OtherFailure" })).not.toExist(),
  );
});

it("deep-links to wording and keeps implementation collapsed", () => {
  const href = errorHref(`${error.file}/${error.name}`);
  const route = routeOf(urlAt(href));
  expect(route._tag).toBe("Error");
  expect(framesOn(data, route)).toEqual([]);
  Scene.scene(
    { update, view },
    Scene.given(loaded(href)),
    settle,
    Scene.expect(Scene.role("heading", { name: "WriterBusy" })).toExist(),
    Scene.expect(Scene.text("No rendered examples")).toExist(),
    Scene.expect(Scene.text("No rendered example yet.")).not.toExist(),
    Scene.expect(Scene.role("region", { name: "CLI output" })).not.toContainText("formatter code"),
    Scene.expect(Scene.role("button", { name: "Definition and fields" })).toHaveAttr(
      "aria-expanded",
      "false",
    ),
  );
});

it("loads a matching failure story and renders it with the error details", () => {
  const story = { ...atlas.stories[0]!, errorTags: [error.tag] };
  const dataWithStory = { ...data, stories: [story] };
  const href = errorHref(`${error.file}/${error.name}`);
  expect(framesOn(dataWithStory, routeOf(urlAt(href)))).toEqual([story.color]);
  Scene.scene(
    { update, view },
    Scene.given({ ...loaded(href), atlas: AtlasData.Success({ data: dataWithStory }) }),
    settle,
    Scene.expect(Scene.role("link", { name: story.key.replace(/^failure\//, "") })).toExist(),
    Scene.expect(Scene.role("group", { name: story.key })).toExist(),
    Scene.expect(Scene.role("button", { name: "Definition and fields" })).toHaveAttr(
      "aria-expanded",
      "false",
    ),
  );
});

it("shows source-backed categories and evidence and can search by category", () => {
  const mixedData = {
    ...data,
    errors: [
      error,
      {
        ...error,
        name: "ProtocolMistake",
        tag: "ProtocolMistake",
        category: "Internal defect" as const,
        evidence: [
          {
            kind: "Defect" as const,
            file: "packages/skit/src/writer.ts",
            line: 30,
            source: "Effect.die(new ProtocolMistake())",
          },
        ],
      },
    ],
  };
  Scene.scene(
    { update, view },
    Scene.given({ ...loaded("#/errors"), atlas: AtlasData.Success({ data: mixedData }) }),
    settle,
    Scene.type(Scene.role("searchbox", { name: "Search errors" }), "internal defect"),
    settle,
    Scene.expect(Scene.role("link", { name: "ProtocolMistake" })).toExist(),
    Scene.expect(Scene.role("link", { name: "WriterBusy" })).not.toExist(),
  );
  Scene.scene(
    { update, view },
    Scene.given(loaded(errorHref(`${error.file}/${error.name}`))),
    settle,
    Scene.expect(Scene.text("Operational failure")).toExist(),
    Scene.expect(Scene.role("heading", { name: "Classification evidence" })).toExist(),
    Scene.expect(Scene.text("Checked failure | packages/skit/src/writer.ts:24")).toExist(),
  );
});

it("links a command to its checked error and back, and separates unlinked definitions", () => {
  const key = `${error.file}/${error.name}`;
  const linked = {
    ...data,
    commands: data.commands.map((command) => ({
      ...command,
      errors: command.command === "add" ? [key] : [],
    })),
  };
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt("#/commands/add/tabs/errors"),
      atlas: AtlasData.Success({ data: linked }),
    }),
    settle,
    Scene.expect(Scene.role("link", { name: "WriterBusy" })).toHaveAttr("href", errorHref(key)),
  );
  Scene.scene(
    { update, view },
    Scene.given({ ...loadedAt(errorHref(key)), atlas: AtlasData.Success({ data: linked }) }),
    settle,
    Scene.expect(Scene.role("link", { name: "skit add" })).toHaveAttr("href", "#/commands/add"),
  );
  Scene.scene(
    { update, view },
    Scene.given({ ...loadedAt("#/errors"), atlas: AtlasData.Success({ data: linked }) }),
    settle,
    Scene.expect(Scene.role("heading", { name: "Operational failure (1)" })).toExist(),
    Scene.expect(Scene.role("heading", { name: "Absent from command error types (1)" })).toExist(),
    Scene.expect(Scene.role("list", { name: "Operational failure" })).not.toContainText(
      "Operational failure",
    ),
    Scene.expect(Scene.role("list", { name: "Absent from command error types" })).toContainText(
      "Operational failure",
    ),
  );
});

it("shows all SetupImportInvalid reasons through the real presenter without template fragments", () => {
  const examples = outputStories.flatMap((story, index) => {
    if (!story.errorTags?.includes("SetupImportInvalid")) return [];
    const rendered = renderOutputFrame(index, { ...defaultTerminalEnvironment, color: false });
    if (!rendered) throw new Error(`Missing output: ${story.key}`);
    return [{ key: story.key, text: rendered.stdout + rendered.stderr }];
  });
  expect(examples).toHaveLength(6);
  const definition = {
    ...error,
    name: "SetupImportInvalid",
    tag: "SetupImportInvalid",
    file: "packages/skit/src/library/failures.ts",
    presentations: [
      {
        file: "packages/cli/src/library/failures.ts",
        source: "const message = `Cannot import ${skillName}: ${reasons[reason]}`;",
      },
    ],
  };
  const stories = examples.map((example) => ({
    key: example.key,
    text: example.text,
    errorTags: [definition.tag],
    issues: [],
    color: `${example.key}.json`,
    plain: `${example.key}.plain.json`,
  }));
  const page = { ...atlas, errors: [definition], stories };
  const frames = Object.fromEntries(
    examples.map((example) => [
      `${example.key}.json`,
      FrameData.Success({
        data: {
          rows: example.text
            .trim()
            .split("\n")
            .map((text) => ({ runs: [{ text }] })),
        },
      }),
    ]),
  );
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt(errorHref(`${definition.file}/${definition.name}`)),
      atlas: AtlasData.Success({ data: page }),
      frames,
    }),
    settle,
    Scene.expect(Scene.role("heading", { name: "CLI output" })).toExist(),
    Scene.expect(Scene.text("6 rendered examples")).toExist(),
    Scene.expect(Scene.role("region", { name: "CLI output" })).toContainText(
      "Cannot import review during setup: the same Skill copy was selected more than once",
    ),
    Scene.expect(Scene.role("region", { name: "CLI output" })).toContainText(
      "the lock file no longer matches the scanned copy",
    ),
    Scene.expect(Scene.role("region", { name: "CLI output" })).not.toContainText("${"),
    Scene.expect(Scene.role("region", { name: "CLI output" })).not.toContainText("reasons[reason]"),
    Scene.expect(Scene.role("button", { name: "Definition and fields" })).toHaveAttr(
      "aria-expanded",
      "false",
    ),
  );
});

it("omits empty category groups when an error search has no matches", () => {
  Scene.scene(
    { update, view },
    Scene.given(loaded("#/errors")),
    settle,
    Scene.type(Scene.role("searchbox", { name: "Search errors" }), "zz-no-matching-error"),
    settle,
    Scene.expect(Scene.text("0 of 2 errors")).toExist(),
    Scene.expect(Scene.text("No errors match.")).toExist(),
    Scene.expectAll(Scene.all.role("heading", { level: 2 })).toHaveCount(0),
  );
});

it("opens independent source disclosures", () => {
  Scene.scene(
    { update, view },
    Scene.given(loaded(errorHref(`${error.file}/${error.name}`))),
    settle,
    Scene.click(Scene.role("button", { name: "Definition and fields" })),
    settle,
    Scene.expect(Scene.role("button", { name: "Definition and fields" })).toHaveAttr(
      "aria-expanded",
      "true",
    ),
    Scene.click(Scene.role("button", { name: "Checked failure | packages/skit/src/writer.ts:24" })),
    settle,
    Scene.expect(Scene.role("button", { name: "Definition and fields" })).toHaveAttr(
      "aria-expanded",
      "true",
    ),
    Scene.expect(
      Scene.role("button", { name: "Checked failure | packages/skit/src/writer.ts:24" }),
    ).toHaveAttr("aria-expanded", "true"),
  );
});
