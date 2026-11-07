import { Schema } from "effect";
import { expect, test } from "vitest";
import { SkillsShLockFileEntry } from "../src/library/library-contracts.js";
import { UsageReport } from "../src/library/usage/contracts.js";

test("usage duration retains fractional milliseconds and rejects invalid durations", () => {
  const duration = Schema.Struct({ durationMs: UsageReport.fields.durationMs });
  for (const durationMs of [0, 0.125, 1.5])
    expect(Schema.encodeSync(duration)({ durationMs })).toEqual({ durationMs });
  for (const durationMs of [-1, NaN, Infinity])
    expect(() => Schema.encodeSync(duration)({ durationMs })).toThrow();
});

test("raw lock versions preserve the historical numeric domain", () => {
  const lock = Schema.Struct({ lock_version: SkillsShLockFileEntry.fields.lock_version });
  for (const lock_version of [1.5, NaN, Infinity, -Infinity]) {
    const decoded = Schema.decodeSync(lock)({ lock_version });
    expect(Object.is(decoded.lock_version, lock_version)).toBe(true);
  }
});
