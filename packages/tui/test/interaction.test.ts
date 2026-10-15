import { expect, test } from "vitest";
import {
  createInteractionController,
  type BrowseContext,
  type ScrollKey,
} from "../src/interaction";

const browse: BrowseContext = {
  section: "library",
  variant: 0,
  viewCount: 6,
  narrow: false,
  narrowDetails: false,
  hasDetails: true,
  insideSkillGroup: false,
  insideCollection: false,
  copySelection: false,
};
function fixture() {
  const events: string[] = [];
  const controller = createInteractionController(() => events.push("render"));
  const view = (name: string) => ({
    mount: () => {
      events.push(`${name}:mount`);
    },
    dispose: () => {
      events.push(`${name}:dispose`);
    },
    focus: () => {
      events.push(`${name}:focus`);
    },
    resize: () => {
      events.push(`${name}:resize`);
    },
    scroll: (key: ScrollKey) => {
      events.push(`${name}:${key}`);
    },
    move: (direction: "up" | "down") => {
      events.push(`${name}:${direction}`);
    },
    update: (showSkills: boolean) => {
      events.push(`${name}:skills:${showSkills}`);
    },
  });
  return { controller, events, view };
}

test("opening a new mode disposes its predecessor; closing returns to browse once", () => {
  const { controller, events, view } = fixture();
  controller.open({ kind: "chooser", view: view("chooser") });
  controller.open({ kind: "confirm", view: view("confirm"), canShowSkills: true });
  expect(controller.kind).toBe("confirm");
  controller.close("chooser");
  expect(controller.kind).toBe("confirm");
  controller.close("confirm");
  controller.close("confirm");
  expect(controller.kind).toBe("browse");
  expect(events).toEqual([
    "chooser:mount",
    "chooser:focus",
    "chooser:dispose",
    "confirm:mount",
    "confirm:focus",
    "confirm:dispose",
    "render",
  ]);
});

for (const kind of ["document", "chooser", "palette", "confirm"] as const) {
  test(`${kind} blocks browse shortcuts while keeping quit and copy global`, () => {
    const { controller, view } = fixture();
    controller.open({ kind, view: view(kind), canShowSkills: false });
    for (const name of ["e", "d", "i", "r", "1", "right", "q"]) {
      expect(controller.handleKey({ name }, browse).command).toBeUndefined();
    }
    expect(controller.handleKey({ name: "p", ctrl: true }, browse).command).toBeUndefined();
    expect(
      controller.handleKey({ name: "c", ctrl: true }, { ...browse, copySelection: true }).command,
    ).toEqual({ kind: "quit" });
    expect(controller.handleKey({ name: "y" }, { ...browse, copySelection: true }).command).toEqual(
      { kind: "copy" },
    );
    expect(controller.kind).toBe(kind);
  });
}

test("confirmation routes apply/cancel and owns the per-confirmation member toggle", () => {
  const { controller, events, view } = fixture();
  controller.open({ kind: "confirm", view: view("confirm"), canShowSkills: true });
  expect(controller.handleKey({ name: "return" }, browse)).toMatchObject({
    command: { kind: "apply" },
    preventDefault: true,
    stopPropagation: true,
  });
  expect(controller.handleKey({ name: "escape" }, browse)).toMatchObject({
    command: { kind: "cancel" },
    stopPropagation: true,
  });
  // Commands leave actual confirmation/cancellation to the Library workflow adapter.
  expect(controller.kind).toBe("confirm");
  controller.handleKey({ name: "s" }, browse);
  controller.handleKey({ name: "s" }, browse);
  controller.open({ kind: "confirm", view: view("next"), canShowSkills: true });
  controller.handleKey({ name: "s" }, browse);
  expect(events.filter((event) => event.includes(":skills:"))).toEqual([
    "confirm:skills:true",
    "confirm:skills:false",
    "next:skills:true",
  ]);
  controller.open({ kind: "confirm", view: view("single"), canShowSkills: false });
  expect(controller.handleKey({ name: "s" }, browse)).toEqual({});
  controller.handleKey({ name: "pagedown" }, browse);
  expect(events.at(-1)).toBe("single:pagedown");
});

for (const kind of ["chooser", "palette"] as const) {
  test(`${kind} owns arrows, lets its focused input handle Enter, and restores browse on Escape`, () => {
    const { controller, events, view } = fixture();
    controller.open({ kind, view: view(kind) });
    expect(controller.handleKey({ name: "up" }, browse)).toMatchObject({
      preventDefault: true,
      stopPropagation: true,
    });
    controller.handleKey({ name: "down" }, browse);
    expect(controller.handleKey({ name: "return" }, browse)).toEqual({});
    const result = controller.handleKey({ name: "escape" }, browse);
    expect(result).toMatchObject({ preventDefault: true, stopPropagation: true });
    expect(result.command).toEqual(kind === "chooser" ? { kind: "cancel" } : undefined);
    expect(controller.kind).toBe("browse");
    expect(events).toEqual([
      `${kind}:mount`,
      `${kind}:focus`,
      `${kind}:up`,
      `${kind}:down`,
      `${kind}:dispose`,
      "render",
    ]);
  });
}

test("document handles boundary scrolling and Escape without applying Library changes", () => {
  const { controller, events, view } = fixture();
  controller.open({ kind: "document", view: view("document") });
  controller.handleKey({ name: "home" }, browse);
  controller.handleKey({ name: "end" }, browse);
  // Arrow and page scrolling remain with the focused document renderable.
  expect(controller.handleKey({ name: "pagedown" }, browse)).toEqual({});
  expect(controller.handleKey({ name: "escape" }, browse).command).toBeUndefined();
  expect(controller.kind).toBe("browse");
  expect(events).toEqual([
    "document:mount",
    "document:focus",
    "document:home",
    "document:end",
    "document:dispose",
    "render",
  ]);
});

test("background renders and resize restore focus to the one active overlay", () => {
  const { controller, events, view } = fixture();
  controller.open({ kind: "palette", view: view("palette") });
  events.length = 0;
  controller.renderBrowse();
  controller.resize();
  expect(events).toEqual(["render", "palette:focus", "render", "palette:resize", "palette:focus"]);
  controller.close("palette");
  events.length = 0;
  controller.resize();
  expect(events).toEqual(["render"]);
});

test("late document reads are invalidated by navigation and modal transitions", () => {
  const { controller, view } = fixture();
  const initial = controller.captureBrowse();
  expect(initial()).toBe(true);
  controller.navigationChanged();
  expect(initial()).toBe(false);
  const reading = controller.captureBrowse();
  controller.open({ kind: "chooser", view: view("chooser") });
  expect(reading()).toBe(false);
  controller.close("chooser");
  expect(reading()).toBe(false);
  expect(controller.captureBrowse()()).toBe(true);
});

test("pending document reads survive background renders and resize", () => {
  const { controller } = fixture();
  const reading = controller.captureBrowse();
  controller.renderBrowse();
  expect(reading()).toBe(true);
  controller.resize();
  expect(reading()).toBe(true);
  controller.navigationChanged();
  expect(reading()).toBe(false);
});

test("browse Escape unwinds narrow details before Skill or Collection navigation", () => {
  const { controller } = fixture();
  expect(
    controller.handleKey(
      { name: "escape" },
      { ...browse, narrow: true, narrowDetails: true, insideCollection: true },
    ),
  ).toMatchObject({ command: { kind: "back-details" }, stopPropagation: true });
  expect(
    controller.handleKey(
      { name: "escape" },
      { ...browse, section: "skills", insideSkillGroup: true },
    ).command,
  ).toEqual({ kind: "back-skills" });
  expect(
    controller.handleKey({ name: "escape" }, { ...browse, insideCollection: true }).command,
  ).toEqual({ kind: "back-collection" });
  expect(controller.handleKey({ name: "escape" }, browse)).toEqual({});
});

test("browse routes Library actions only from the Library and cycles views at the boundaries", () => {
  const { controller } = fixture();
  for (const [name, kind] of [
    ["e", "enable"],
    ["d", "disable"],
    ["i", "invocation"],
    ["r", "refresh"],
  ]) {
    expect(controller.handleKey({ name: name! }, browse)).toMatchObject({
      command: { kind },
      stopPropagation: true,
    });
    expect(controller.handleKey({ name: name! }, { ...browse, section: "skills" })).toEqual({});
  }
  expect(controller.handleKey({ name: "left" }, browse).command).toEqual({
    kind: "switch-view",
    index: 5,
  });
  expect(controller.handleKey({ name: "right" }, { ...browse, variant: 5 }).command).toEqual({
    kind: "switch-view",
    index: 0,
  });
  expect(controller.handleKey({ name: "3" }, browse).command).toEqual({
    kind: "switch-view",
    index: 2,
  });
  expect(
    controller.handleKey({ name: "p", shift: true }, { ...browse, section: "harnesses" }).command,
  ).toEqual({ kind: "probe", all: true });
  expect(
    controller.handleKey({ name: "p", ctrl: true }, { ...browse, section: "harnesses" }).command,
  ).toEqual({ kind: "open-palette" });
});
