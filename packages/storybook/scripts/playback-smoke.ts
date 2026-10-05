import assert from "node:assert/strict";
import type { TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mountStorybook } from "../src/browser";

const hostPalette: TerminalColors = {
  palette: Array.from({ length: 16 }, (_, index) => (index === 6 ? "#123456" : "#aabbcc")),
  defaultForeground: "#d0d1d2",
  defaultBackground: "#101112",
  cursorColor: null,
  mouseForeground: null,
  mouseBackground: null,
  tekForeground: null,
  tekBackground: null,
  highlightBackground: null,
  highlightForeground: null,
};

const harness = await createTestRenderer({ width: 130, height: 40, kittyKeyboard: true });
const app = mountStorybook(harness.renderer, {
  animate: false,
  palette: hostPalette,
});
const settle = async () => {
  await harness.flush();
  await app.settled();
  await harness.flush();
};

try {
  await settle();
  await harness.mockInput.typeText("journey/library-sync/fresh-device");
  await settle();
  assert.equal(app.state().key, "journey/library-sync/fresh-device");
  assert.ok((app.state().count ?? 0) > 8);
  harness.mockInput.pressTab();
  assert.equal(app.state().focus, "preview");
  while (!app.state().status?.startsWith("Downloading")) harness.mockInput.pressKey("ARROW_RIGHT");
  await harness.flush();
  const headingSpan = () =>
    harness
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("This device"));
  assert.equal(app.state().color, false);
  assert.deepEqual(headingSpan()?.fg.toInts().slice(0, 3), [208, 209, 210]);
  assert.deepEqual(headingSpan()?.bg.toInts().slice(0, 3), [16, 17, 18]);
  harness.mockInput.pressKey("l", { ctrl: true });
  await settle();
  assert.equal(app.state().color, true);
  assert.deepEqual(
    headingSpan()?.fg.toInts().slice(0, 3),
    [18, 52, 86],
    "ANSI cyan must use the host palette",
  );
  harness.mockInput.pressKey("l", { ctrl: true });
  await settle();
  assert.equal(app.state().color, false);
  assert.deepEqual(
    headingSpan()?.fg.toInts().slice(0, 3),
    [208, 209, 210],
    "turning colour off must remove recorded plan styling",
  );
  const pausedIndex = app.state().index;
  const before = app.screen().text;
  app.tick();
  await harness.flush();
  assert.equal(app.state().index, pausedIndex);
  assert.notEqual(app.screen().text, before, "spinner should animate while advancement is paused");
  assert.match(app.screen().text, /Downloading Skill copies · 0\/3/);
  harness.mockInput.pressKey("ARROW_RIGHT");
  await harness.flush();
  assert.match(app.screen().text, /Downloading Skill copies · 1\/3/);
  harness.mockInput.pressKey("ARROW_LEFT");
  await harness.flush();
  assert.match(app.screen().text, /Downloading Skill copies · 0\/3/);
  harness.mockInput.pressKey(" ");
  assert.equal(app.state().playing, true);
  app.tick(1000);
  assert.equal(app.state().index, (pausedIndex ?? 0) + 1);
  harness.mockInput.pressKey(" ");
  assert.equal(app.state().playing, false);
  harness.mockInput.pressKey("t");
  assert.equal(app.state().transcript, true);
  await harness.flush();
  assert.match(harness.captureCharFrame(), /TRANSCRIPT/);
  harness.mockInput.pressKey("t");
  harness.mockInput.pressKey("HOME");
  assert.equal(app.state().index, 0);
  for (let index = 0; index < (app.state().count ?? 0); index++) harness.mockInput.pressEnter();
  await harness.flush();
  assert.match(app.screen().text, /Library synced\./);
  assert.equal(app.state().status, undefined);
  harness.mockInput.pressKey("f", { ctrl: true });
  await settle();
  assert.equal(app.state().count, 2, "JSON replay should contain only ready and result");
  assert.match(harness.captureCharFrame(), /skit.library.sync.v7/);
  assert.doesNotMatch(harness.captureCharFrame(), /Downloading/);
  harness.mockInput.pressKey("f", { ctrl: true });
  await settle();
  harness.mockInput.pressTab();
  harness.mockInput.pressEscape();
  await settle();
  await harness.mockInput.typeText("journey/library-sync/download-failed");
  await settle();
  assert.equal(app.state().key, "journey/library-sync/download-failed");
  assert.ok((app.state().count ?? 0) > 5, JSON.stringify(app.state()));
  harness.mockInput.pressTab();
  for (let index = 0; index < (app.state().count ?? 0); index++) harness.mockInput.pressEnter();
  await harness.flush();
  assert.match(app.screen().text, /Error:/);
  assert.doesNotMatch(app.screen().text, /Library synced\./);
  assert.equal(app.state().status, undefined);
  console.log(
    "Storybook playback smoke passed: stepping, animation, playback, transcript, JSON, failure.",
  );
} finally {
  harness.renderer.destroy();
}

for (const options of [
  { palette: undefined },
  { palette: { ...hostPalette, palette: ["#123456", null] } },
]) {
  const harness = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true });
  try {
    const app = mountStorybook(harness.renderer, { animate: false, ...options });
    await harness.flush();
    await app.settled();
    assert.equal(app.state().color, false);
    assert.equal(app.state().paletteSource, options.palette ? "mixed" : "fallback");
    harness.mockInput.pressKey("l", { ctrl: true });
    await harness.flush();
    await app.settled();
    await harness.flush();
    assert.equal(
      app.state().color,
      true,
      "explicit colour toggle must work with incomplete detection",
    );
    assert.match(
      harness.captureCharFrame(),
      options.palette ? /mixed palette/ : /fallback palette/,
    );
    harness.mockInput.pressKey("l", { ctrl: true });
    await harness.flush();
    await app.settled();
    assert.equal(app.state().color, false);
  } finally {
    harness.renderer.destroy();
  }
}
console.log(
  "Storybook colour smoke passed: neutral default, host palette, toggle, partial and missing detection.",
);
