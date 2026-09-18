import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectInstalledHarnesses } from "../src/harness/catalog.js";

describe("harness probing", () => {
  test("detects supported harnesses from their filesystem markers", () => {
    const home = "/test/home";
    const configHome = join(home, ".config");
    const present = new Set([
      join(home, ".codex"),
      join(home, ".claude"),
      join(configHome, "opencode"),
      join(configHome, "devin"),
    ]);
    expect(
      detectInstalledHarnesses({ home, configHome, exists: (path) => present.has(path) }),
    ).toEqual(["codex", "claude-code", "opencode", "devin"]);
  });

  test("treats explicit projection roots as installed harnesses", () => {
    expect(
      detectInstalledHarnesses({
        home: "/empty",
        exists: () => false,
        codexRoot: "/codex",
      }),
    ).toEqual(["codex"]);
  });

  test("does not infer Devin availability from repository projection support", () => {
    expect(detectInstalledHarnesses({ home: "/empty", exists: () => false })).toEqual([]);
    expect(
      detectInstalledHarnesses({
        home: "/empty",
        devinRoots: ["/repo/.devin/skills"],
        exists: () => false,
      }),
    ).toEqual([]);
  });
});
