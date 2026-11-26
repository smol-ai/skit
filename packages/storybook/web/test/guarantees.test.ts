import { describe, expect, it } from "vitest";
import { commandGuarantees } from "../src/pages/guarantees.ts";
import { atlas } from "./fixture.ts";

const test = (title: string, ancestorTitles: string[]) => ({
  name: [...ancestorTitles, title].join(" "),
  title,
  ancestorTitles,
  status: "passed" as const,
});

describe("guarantee membership from describe ancestry", () => {
  it("excludes passing tests from stale and unverified reports", () => {
    const files = [{ file: "example.ts", tests: [test("one", ["skit example", "Same promise."])] }];
    const groups = commandGuarantees(
      {
        ...atlas,
        testReports: [
          { package: "cli", startTime: 1000, provenance: "stale", files },
          { package: "skit", startTime: 2000, provenance: "unverified", files },
        ],
      },
      "example",
    );
    expect(groups).toEqual([]);
  });

  it("merges the same section and guarantee across files, respecting file-declared section order", () => {
    const reports = [
      {
        package: "cli",
        startTime: 1000,
        provenance: "current" as const,
        files: [
          { file: "first.ts", tests: [test("one", ["skit example", "Second", "Same promise."])] },
          {
            file: "later.ts",
            tests: [
              test("two", ["skit example", "First", "Same promise."]),
              test("three", ["skit example", "Second", "Same promise."]),
              test("ungrouped", []),
              test("other", ["skit other", "First", "Same promise."]),
            ],
          },
        ],
      },
    ];
    const groups = commandGuarantees({ ...atlas, testReports: reports }, "example");
    expect(groups.map((g) => [g.sections, g.title, g.tests.map((t) => t.test.title)])).toEqual([
      [["First"], "Same promise.", ["two"]],
      [["Second"], "Same promise.", ["one", "three"]],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it("handles no section or several section levels without command-name special cases", () => {
    const groups = commandGuarantees(
      {
        ...atlas,
        testReports: [
          {
            package: "core",
            startTime: 1000,
            provenance: "current" as const,
            files: [
              {
                file: "generic.ts",
                tests: [
                  test("flat", ["skit example", "Flat promise."]),
                  test("nested", ["skit example", "Outer", "Inner", "Nested promise."]),
                  test("no guarantee", ["skit example"]),
                ],
              },
            ],
          },
        ],
      },
      "example",
    );
    expect(groups.map((g) => [g.sections, g.title])).toEqual([
      [[], "Flat promise."],
      [["Outer", "Inner"], "Nested promise."],
    ]);
  });
  it("adds later describe blocks to an existing section without reversing its order", () => {
    const groups = commandGuarantees(
      {
        ...atlas,
        testReports: [
          {
            package: "cli",
            startTime: 1000,
            provenance: "current" as const,
            files: [
              {
                file: "revisited.ts",
                tests: [
                  test("one", ["skit example", "First", "First promise."]),
                  test("two", ["skit example", "Second", "Second promise."]),
                  test("three", ["skit example", "First", "Later promise."]),
                ],
              },
            ],
          },
        ],
      },
      "example",
    );
    expect(groups.map((group) => [group.sections, group.title])).toEqual([
      [["First"], "First promise."],
      [["First"], "Later promise."],
      [["Second"], "Second promise."],
    ]);
  });

  it("still refuses contradictory section positions declared by different files", () => {
    const reports = [
      {
        package: "cli",
        startTime: 1000,
        provenance: "current" as const,
        files: [
          {
            file: "first.ts",
            tests: [
              test("one", ["skit example", "First", "One."]),
              test("two", ["skit example", "Second", "Two."]),
            ],
          },
          {
            file: "second.ts",
            tests: [
              test("three", ["skit example", "Second", "Three."]),
              test("four", ["skit example", "First", "Four."]),
            ],
          },
        ],
      },
    ];
    expect(() => commandGuarantees({ ...atlas, testReports: reports }, "example")).toThrow(
      "Conflicting test section order",
    );
  });
});
