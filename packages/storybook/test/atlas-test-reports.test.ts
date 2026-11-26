import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { readTestReports } from "../src/atlas/test-reports.ts";

it("reads every saved file without command or filename selection, preserving statuses and run time", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-tests-"));
  try {
    expect(await Effect.runPromise(readTestReports(root))).toEqual([]);
    const folder = join(root, "packages/cli/.atlas");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "vitest.json"),
      JSON.stringify({
        startTime: 1794448800000,
        testResults: [
          {
            name: join(root, "packages/cli/test/scenario-sets.test.ts"),
            assertionResults: [
              {
                fullName: "author-sync/first-connection",
                title: "author-sync/first-connection",
                ancestorTitles: [],
                status: "passed",
              },
            ],
          },
          {
            name: join(root, "packages/cli/test/author-watch.test.ts"),
            assertionResults: ["passed", "failed", "skipped", "pending", "todo", "disabled"].map(
              (status) => ({ fullName: status, title: status, ancestorTitles: [], status }),
            ),
          },
          {
            name: join(root, "packages/cli/test/contract.test.ts"),
            assertionResults: [
              {
                fullName: "skit author watch Files are saved. author-watch/atomic-save",
                title: "author-watch/atomic-save",
                ancestorTitles: ["skit author watch", "Files are saved."],
                status: "failed",
              },
              { fullName: "unrelated", title: "unrelated", ancestorTitles: [], status: "passed" },
            ],
          },
          { name: join(root, "packages/cli/test/unrelated.test.ts"), assertionResults: [] },
        ],
      }),
    );
    const reports = await Effect.runPromise(readTestReports(root));
    expect(reports).toEqual([
      {
        package: "cli",
        provenance: "unverified",
        startTime: 1794448800000,
        files: [
          {
            file: "packages/cli/test/author-watch.test.ts",
            tests: [
              { name: "passed", title: "passed", ancestorTitles: [], status: "passed" },
              { name: "failed", title: "failed", ancestorTitles: [], status: "failed" },
              { name: "skipped", title: "skipped", ancestorTitles: [], status: "skipped" },
              { name: "pending", title: "pending", ancestorTitles: [], status: "skipped" },
              { name: "todo", title: "todo", ancestorTitles: [], status: "todo" },
              { name: "disabled", title: "disabled", ancestorTitles: [], status: "skipped" },
            ],
          },
          {
            file: "packages/cli/test/contract.test.ts",
            tests: [
              {
                name: "skit author watch Files are saved. author-watch/atomic-save",
                title: "author-watch/atomic-save",
                ancestorTitles: ["skit author watch", "Files are saved."],
                status: "failed",
              },
              { name: "unrelated", title: "unrelated", ancestorTitles: [], status: "passed" },
            ],
          },
          {
            file: "packages/cli/test/scenario-sets.test.ts",
            tests: [
              {
                name: "author-sync/first-connection",
                title: "author-sync/first-connection",
                ancestorTitles: [],
                status: "passed",
              },
            ],
          },
          { file: "packages/cli/test/unrelated.test.ts", tests: [] },
        ],
      },
    ]);
    await writeFile(join(folder, "vitest.json"), "{invalid");
    expect((await Effect.runPromise(Effect.result(readTestReports(root))))._tag).toBe("Failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
