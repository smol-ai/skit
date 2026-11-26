import * as Scene from "foldkit/scene";
import { it } from "vitest";
import { update, view } from "../src/main.ts";
import { AtlasData } from "../src/model.ts";
import { commandHref, commandTabHref, flowHref, storyHref } from "../src/route.ts";
import { atlas, loadedAt } from "./fixture.ts";
import { settle } from "./settle.ts";

for (const command of ["doctor", "author watch"])
  it(`gives ${command} the shared Commands prefix with a non-navigable current crumb`, () => {
    Scene.scene(
      { update, view },
      Scene.given({
        ...loadedAt(commandHref(command)),
        atlas: AtlasData.Success({
          data: { ...atlas, commands: [{ ...atlas.commands[0]!, command }] },
        }),
      }),
      settle,
      Scene.expect(Scene.selector('nav[aria-label="Breadcrumb"]')).toContainText(`Commands`),
      Scene.expectAll(Scene.all.selector('nav[aria-label="Breadcrumb"] a[href="#/"]')).toHaveCount(
        2,
      ),
      Scene.expect(Scene.selector('nav[aria-label="Breadcrumb"] [aria-current="page"]')).toHaveText(
        `skit ${command}`,
      ),
      Scene.expect(
        Scene.selector('nav[aria-label="Breadcrumb"] a[aria-current="page"]'),
      ).not.toExist(),
      Scene.expect(Scene.text("Top level")).not.toExist(),
    );
  });

for (const command of ["doctor", "author watch"])
  it(`extends ${command}'s trail with its Flows tab and current recording`, () => {
    const flow = {
      ...atlas.flows[0]!,
      name: `${command.replaceAll(" ", "-")}/healthy`,
      commands: [command],
    };
    Scene.scene(
      { update, view },
      Scene.given({
        ...loadedAt(flowHref(flow.name, 1)),
        atlas: AtlasData.Success({ data: { ...atlas, flows: [flow] } }),
      }),
      settle,
      Scene.expectAll(Scene.all.selector('nav[aria-label="Breadcrumb"] a')).toHaveCount(4),
      Scene.expect(
        Scene.selector(`nav[aria-label="Breadcrumb"] a[href="${commandHref(command)}"]`),
      ).toHaveText(`skit ${command}`),
      Scene.expect(
        Scene.selector(
          `nav[aria-label="Breadcrumb"] a[href="${commandTabHref(command, "flows")}"]`,
        ),
      ).toHaveText("Flows"),
      Scene.expect(Scene.selector('nav[aria-label="Breadcrumb"] [aria-current="page"]')).toHaveText(
        flow.name,
      ),
      Scene.expect(
        Scene.selector('nav[aria-label="Breadcrumb"] a[aria-current="page"]'),
      ).not.toExist(),
      Scene.expect(Scene.text("Step 1")).not.toExist(),
    );
  });

it("links a recording that runs several commands through the global Flows index", () => {
  const flow = { ...atlas.flows[0]!, commands: ["add", "sync"] };
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt(flowHref(flow.name, 1)),
      atlas: AtlasData.Success({ data: { ...atlas, flows: [flow] } }),
    }),
    settle,
    Scene.expectAll(Scene.all.selector('nav[aria-label="Breadcrumb"] a')).toHaveCount(2),
    Scene.expect(Scene.selector('nav[aria-label="Breadcrumb"] a[href="#/flows"]')).toHaveText(
      "Flows",
    ),
    Scene.expect(Scene.selector('nav[aria-label="Breadcrumb"] [aria-current="page"]')).toHaveText(
      flow.name,
    ),
    Scene.expect(Scene.selector('nav[aria-label="Breadcrumb"]')).not.toContainText("skit add"),
  );
});

for (const owners of [0, 1, 2])
  it(`uses the command trail only when a story has exactly one referring command (${owners})`, () => {
    const story = atlas.stories[0]!;
    const commands = atlas.commands.map((command, index) => ({
      ...command,
      stories: index < owners ? [story.key] : [],
    }));
    Scene.scene(
      { update, view },
      Scene.given({
        ...loadedAt(storyHref(story.key)),
        atlas: AtlasData.Success({ data: { ...atlas, commands } }),
      }),
      settle,
      Scene.expectAll(Scene.all.selector('nav[aria-label="Breadcrumb"] a')).toHaveCount(
        owners === 1 ? 4 : 1,
      ),
      Scene.expect(Scene.selector('nav[aria-label="Breadcrumb"] [aria-current="page"]')).toHaveText(
        story.key,
      ),
      ...(owners === 1
        ? [
            Scene.expect(
              Scene.selector(
                `nav[aria-label="Breadcrumb"] a[href="${commandTabHref(commands[0]!.command, "results")}"]`,
              ),
            ).toHaveText("Results"),
          ]
        : [
            Scene.expect(Scene.selector('nav[aria-label="Breadcrumb"]')).not.toContainText(
              "Commands",
            ),
          ]),
    );
  });
