#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { mountStorybook } from "./browser";

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
  useMouse: true,
});
mountStorybook(renderer);
