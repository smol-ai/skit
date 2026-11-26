import * as Scene from "foldkit/scene";
import { describe, it } from "vitest";
import * as Accordion from "../src/fluid/components/accordion";
import { AccordionRuntime } from "../src/fluid/components/accordion/runtime";
import * as Item from "../src/components/item.ts";
import * as PageHeader from "../src/components/page-header.ts";
import * as DataList from "../src/components/data-list.ts";
import * as Badge from "../src/fluid/components/badge";

describe("Badge semantic tones", () => {
  const tones: readonly Badge.Tone[] = ["success", "warning", "destructive", "info"];
  for (const tone of tones)
    it(`resolves ${tone} through the theme instead of the hue palette`, () => {
      Scene.scene<null, never>(
        {
          update: (model) => ({ model }),
          view: (_model, h) =>
            Badge.view({ children: [tone], tone, color: "gray", variant: "dot" }, h),
        },
        Scene.given(null),
        Scene.expect(Scene.text(tone)).toExist(),
        Scene.expect(Scene.selector(`[data-color="${tone}"]`)).toHaveStyle(
          "--badge-color",
          `var(--${tone})`,
        ),
      );
    });
});

const options: Accordion.Options = {
  type: "multiple",
  items: [
    { value: "one", label: "First item" },
    { value: "two", label: "Second item" },
  ],
};

describe("vendored Accordion", () => {
  it("keeps the registry's default label path", () => {
    Scene.scene<Accordion.Model, Accordion.Message>(
      {
        update: (model, message) => ({ model: Accordion.update(model, message, options) }),
        view: (model, h) => Accordion.view(model, { ...options, id: "default-accordion" }, h),
      },
      Scene.given(Accordion.init(options)),
      Scene.Mount.resolve(AccordionRuntime, Accordion.Message.Noop()),
      Scene.expect(Scene.role("button", { name: "First item" })).toHaveAttr(
        "aria-expanded",
        "false",
      ),
      Scene.expect(Scene.role("button", { name: "Second item" })).toHaveAttr(
        "aria-expanded",
        "false",
      ),
    );
  });

  it("renders custom labels and content while preserving independent expansion", () => {
    Scene.scene<Accordion.Model, Accordion.Message>(
      {
        update: (model, message) => ({ model: Accordion.update(model, message, options) }),
        view: (model, h) =>
          Accordion.view(
            model,
            {
              ...options,
              id: "custom-accordion",
              renderLabel: (value) => h.span([], [`${value} status`]),
              renderContent: (value) => h.p([], [`${value} content`]),
            },
            h,
          ),
      },
      Scene.given(Accordion.init(options)),
      Scene.Mount.resolve(AccordionRuntime, Accordion.Message.Noop()),
      Scene.click(Scene.role("button", { name: "one status" })),
      Scene.click(Scene.role("button", { name: "two status" })),
      Scene.expect(Scene.role("button", { name: "one status" })).toHaveAttr(
        "aria-expanded",
        "true",
      ),
      Scene.expect(Scene.role("button", { name: "two status" })).toHaveAttr(
        "aria-expanded",
        "true",
      ),
      Scene.expect(Scene.text("one content")).toExist(),
      Scene.expect(Scene.text("two content")).toExist(),
    );
  });
});

it("composes a header, metadata and navigable list without domain-specific inputs", () => {
  Scene.scene<null, never>(
    {
      update: (model) => ({ model }),
      view: (_model, h) =>
        h.main(
          [],
          [
            PageHeader.view(
              {
                title: ["Component example"],
                description: ["Supporting description"],
                metadata: [
                  DataList.view(
                    {
                      label: "Run metadata",
                      items: [
                        { key: "recorded", label: ["Recorded"], value: ["2026-11-12T04:00:00Z"] },
                      ],
                    },
                    h,
                  ),
                ],
              },
              h,
            ),
            Item.group(
              {
                label: "Examples",
                items: [
                  {
                    key: "first",
                    title: ["First example"],
                    href: "#first",
                    description: ["A secondary line"],
                    metadata: ["Source location"],
                    actions: [h.a([h.Href("#details")], ["Details"])],
                  },
                ],
              },
              h,
            ),
          ],
        ),
    },
    Scene.given(null),
    Scene.expect(Scene.role("heading", { name: "Component example", level: 1 })).toExist(),
    Scene.expect(Scene.text("Supporting description")).toExist(),
    Scene.expect(Scene.text("Recorded")).toExist(),
    Scene.expect(Scene.text("2026-11-12T04:00:00Z")).toExist(),
    Scene.expect(Scene.role("list", { name: "Examples" })).toExist(),
    Scene.expect(Scene.role("link", { name: "First example" })).toHaveAttr("href", "#first"),
    Scene.expect(Scene.role("link", { name: "First example" })).toContainText("A secondary line"),
    Scene.expect(Scene.selector("a a")).not.toExist(),
    Scene.expect(Scene.selector("a button")).not.toExist(),
    Scene.expect(Scene.text("Source location")).toExist(),
    Scene.expect(Scene.role("link", { name: "Details" })).toHaveAttr("href", "#details"),
  );
});
