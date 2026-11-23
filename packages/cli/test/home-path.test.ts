import { describe, expect, it } from "vitest";
import { compactHome } from "../src/terminal/home-path.js";

describe("compactHome", () => {
  it("shows home as ~ wherever it starts a path, and only as a whole directory name", () => {
    expect(
      compactHome(
        "cli-ux already exists at /Users/tim/.claude/skills/cli-ux (resolved: /Users/tim/x); /Users/tim",
        "/Users/tim",
      ),
    ).toBe("cli-ux already exists at ~/.claude/skills/cli-ux (resolved: ~/x); ~");
    expect(compactHome("projection:/Users/tim/.agents/skills/a:collision", "/Users/tim")).toBe(
      "projection:~/.agents/skills/a:collision",
    );
    expect(compactHome("/Users/timothy/skills and /Users/tim-old", "/Users/tim")).toBe(
      "/Users/timothy/skills and /Users/tim-old",
    );
    expect(compactHome("Only this repository | \u001b[2m/Users/tim\u001b[22m", "/Users/tim")).toBe(
      "Only this repository | \u001b[2m~\u001b[22m",
    );
  });

  it("shortens the complete canonical macOS home without changing interior path components", () => {
    const home = "/var/folders/test/machine-b";
    expect(compactHome(`Source /private${home}/code/tools`, home)).toBe("Source ~/code/tools");
    expect(compactHome(`Source /other${home}/code/tools`, home)).toBe(
      `Source /other${home}/code/tools`,
    );
  });

  it("leaves text alone when home is empty or the filesystem root", () => {
    expect(compactHome("/etc/skills", "/")).toBe("/etc/skills");
    expect(compactHome("/etc/skills", "")).toBe("/etc/skills");
  });
});
