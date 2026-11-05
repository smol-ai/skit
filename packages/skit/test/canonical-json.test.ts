import { expect, test } from "vitest";
import { canonicalJson } from "../src/shared/json.js";

test("exact device and inode numbers hash exactly as their former JSON numbers", () => {
  expect(canonicalJson({ ino: 12345678n, dev: 16777220n })).toBe(
    canonicalJson({ ino: 12345678, dev: 16777220 }),
  );
  expect(canonicalJson([2n ** 64n - 1n])).toBe("[18446744073709551615]");
});
