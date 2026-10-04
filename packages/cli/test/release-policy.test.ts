import { expect, it } from "vitest";
import { passiveCheckEnabled } from "../src/releases/policy.js";
const release = { kind: "release" as const, version: "0.2.0", commit: "abc" };
const interactive = { tty: true, json: false, ci: false, disabled: false, argv: ["list"] };
it("permits passive checks only for interactive release commands", () => {
  expect(passiveCheckEnabled(release, interactive)).toBe(true);
  for (const options of [
    { tty: false },
    { json: true },
    { ci: true },
    { disabled: true },
    ...["version", "--version", "-v", "--help", "-h"].map((arg) => ({ argv: [arg] })),
  ]) {
    expect(passiveCheckEnabled(release, { ...interactive, ...options })).toBe(false);
  }
  expect(passiveCheckEnabled({ kind: "dev", version: "0.2.0" }, interactive)).toBe(false);
});
