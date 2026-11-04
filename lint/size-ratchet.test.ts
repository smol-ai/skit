import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as size from "../architecture/size.mjs";
import { exceeded, measure, newAllowances } from "../scripts/check-architecture.mjs";

const root = join(import.meta.dirname, "..");

describe("size ratchet", () => {
  test("a limit can fall but not rise", () => {
    expect(newAllowances(120, 100, "lines.cli")).toEqual([]);
    expect(newAllowances(100, 120, "lines.cli")).toEqual(["lines.cli: raised from 100 to 120"]);
  });

  test("growth and unmeasured entries fail against the limits", () => {
    expect(
      exceeded({ featureFiles: { enable: 20 } }, { featureFiles: { enable: 21, disable: 3 } }),
    ).toEqual([
      "featureFiles.enable: 21 exceeds approved 20",
      "featureFiles.disable: 3 has no approved limit",
    ]);
  });

  test("the tree matches architecture/size.mjs exactly", { timeout: 60_000 }, () => {
    const limits = {
      lines: size.lines,
      publicExports: size.publicExports,
      featureFiles: size.featureFiles,
    };
    const measured = measure(root);
    // Growth fails; so does a stale limit, so every shrink is locked in by lowering its number.
    expect(
      measured,
      "Update architecture/size.mjs: lower stale limits; growth needs review",
    ).toEqual(limits);
  });
});
