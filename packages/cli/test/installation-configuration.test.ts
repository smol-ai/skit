import { describe, expect, test } from "vitest";
import { libraryInstallationConfiguration } from "../src/library/installation-configuration.js";

const roots = {
  home: "/home/tester",
  configHome: "/home/tester/.config",
  overrides: {},
};

describe("Library installation configuration", () => {
  test("resolves native global roots only for detected harnesses", () => {
    const installation = libraryInstallationConfiguration("/library", roots, [
      "codex",
      "claude-code",
    ]);

    expect(installation.rootFor("codex")).toBe("/home/tester/.agents/skills");
    expect(installation.rootFor("claude-code")).toBe("/home/tester/.claude/skills");
    expect(installation.rootFor("opencode")).toBeUndefined();
    expect(installation.rootFor("devin")).toBeUndefined();
  });

  test("honors direct overrides while Devin keeps its native projection root", () => {
    const installation = libraryInstallationConfiguration(
      "/library",
      {
        ...roots,
        overrides: {
          codex: "/custom/codex",
          devin: ["/custom/devin"],
        },
      },
      ["codex", "devin"],
    );

    expect(installation.rootFor("codex")).toBe("/custom/codex");
    expect(installation.rootFor("devin")).toBe("/home/tester/.config/devin/skills");
  });
});
