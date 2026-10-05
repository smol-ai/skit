import assert from "node:assert/strict";
import { createTestRenderer } from "@opentui/core/testing";
import { mountStorybook } from "../src/browser";

const harness = await createTestRenderer({ width: 130, height: 40, kittyKeyboard: true });
const app = mountStorybook(harness.renderer, { animate: false });
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
