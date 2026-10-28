import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessName } from "../contracts.js";
import { installSkillsDirectory } from "./catalog.js";

export function defaultSkillsRoot(harness: Exclude<HarnessName, "devin">): string {
  return installSkillsDirectory(harness, "global", {
    home: homedir(),
    configHome: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  })!;
}
