import { describe, expect, test } from "vitest";
import { libraryInstallationConfiguration } from "../src/library/installation-configuration.js";

const roots = {
  home: "/home/tester",
  configHome: "/home/tester/.config",
  overrides: {},
};

describe("Library installation configuration", () => {
  test("always projects into .agents and into .claude only when Claude Code is present", () => {
    const withClaude = libraryInstallationConfiguration("/library", roots, ["claude-code"]);
    expect(withClaude.rootFor("agents")).toBe("/home/tester/.agents/skills");
    expect(withClaude.rootFor("claude")).toBe("/home/tester/.claude/skills");

    const withoutClaude = libraryInstallationConfiguration("/library", roots, [
      "codex",
      "opencode",
      "devin",
    ]);
    expect(withoutClaude.rootFor("agents")).toBe("/home/tester/.agents/skills");
    expect(withoutClaude.rootFor("claude")).toBeUndefined();
  });

  test("honors direct root overrides", () => {
    const installation = libraryInstallationConfiguration(
      "/library",
      { ...roots, overrides: { codex: "/custom/agents", claude: "/custom/claude" } },
      ["claude-code"],
    );

    expect(installation.rootFor("agents")).toBe("/custom/agents");
    expect(installation.rootFor("claude")).toBe("/custom/claude");
  });
});
