#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { mountStorybook } from "./browser";

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
  useMouse: true,
});
const palette = await renderer.getPalette({ size: 16, timeout: 250 }).catch(() => undefined);
mountStorybook(renderer, { palette });
