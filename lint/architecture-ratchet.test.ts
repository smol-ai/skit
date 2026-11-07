import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { comparePolicy, newAllowances, policy } from "../scripts/check-architecture.mjs";

const { parse } = createRequire(new URL("../packages/skit/package.json", import.meta.url))("acorn");

describe("architecture baseline", () => {
  test("existing violations do not authorize adding another exemption", () => {
    expect(
      newAllowances({ "old.ts": ["LibraryStore"] }, { "old.ts": ["LibraryStore", "withHomeLock"] }),
    ).toEqual(["debt.old.ts: added withHomeLock"]);
    expect(newAllowances({}, { "new.ts": ["LibraryStore"] })).toEqual(["debt: added new.ts"]);
  });
  test("closing violations can remove their allowances", () => {
    expect(
      newAllowances({ "old.ts": ["LibraryStore", "withHomeLock"] }, { "old.ts": ["LibraryStore"] }),
    ).toEqual([]);
    expect(newAllowances({ "old.ts": ["LibraryStore"] }, {})).toEqual([]);
  });
  test("debt can shrink while approved owner and service rules stay fixed", () => {
    const prior = {
      owners: ["Library"],
      approvedServices: ["Library"],
      debt: { "old.ts": ["LibraryStore"] },
    };
    expect(comparePolicy(prior, { ...prior, debt: {} }, ["debt"])).toEqual([]);
    expect(
      comparePolicy(prior, { ...prior, approvedServices: ["Library", "AuthorSync"] }, ["debt"]),
    ).toEqual(["approvedServices: approved rule changed"]);
    expect(comparePolicy(prior, { ...prior, owners: [] }, ["debt"])).toEqual([
      "owners: approved rule changed",
    ]);
  });
  test("a changed service-debt replacement is not a shrink", () => {
    expect(
      newAllowances({ TreeHasher: "plain function" }, { TreeHasher: "approved service" }),
    ).toEqual(["debt.TreeHasher: changed allowance"]);
  });
  test("candidate policy is parsed as data and cannot execute code", () => {
    expect(policy(parse, 'export const debt = { "old.ts": ["LibraryStore"] };')).toEqual({
      debt: { "old.ts": ["LibraryStore"] },
    });
    for (const source of [
      'export const debt = (() => { throw new Error("executed") })();',
      "export const debt = { get bypass() { return []; } };",
      "export const debt = { ...other };",
      "globalThis.changed = true; export const debt = {};",
    ])
      expect(() => policy(parse, source)).toThrow("literal");
  });
});
