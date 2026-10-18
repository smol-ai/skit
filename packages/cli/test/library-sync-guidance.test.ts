import { describe, expect, it } from "vitest";
import { renderLibrarySync } from "../src/presentation/library-sync.js";
import { setupStepPlan } from "../src/presentation/setup-steps.js";
import { terminalSyncProgress } from "../src/presentation/sync-progress.js";
import { Effect } from "effect";

describe("Library guidance", () => {
  it("explains the scope and meaning of a first upload before applying", () => {
    const output = renderLibrarySync({
      status: "push_ready",
      snapshots: 100,
      plan: { local: [], remote: [] },
    });
    expect(output).toContain("whole Library");
    expect(output).toContain("100 saved copies to upload");
    expect(output).toContain("older version");
    expect(output).toContain("No changes applied");
    expect(output).toContain("skit sync --apply");
  });

  it("reports copies that still need review after a successful sync", () => {
    const output = renderLibrarySync({
      status: "pushed",
      projection_conflicts: [{ skill: "review", path: "/skills/review" }],
    });
    expect(output).toContain("Library synced.");
    expect(output).toContain("review: /skills/review");
    expect(output).toContain("SKIT kept their existing files");
    expect(output).toContain("skit doctor");
  });

  it("shows both transfer directions for a merge preview", () => {
    const output = renderLibrarySync({
      status: "merge_ready",
      snapshots_to_upload: 3,
      snapshots_to_download: 2,
      plan: { local: [], remote: [] },
    });
    expect(output).toContain("3 upload, 2 download");
    expect(output).toContain("this device: no changes; remote: no changes");
    expect(output).toContain("Locally edited installed copies are preserved");
  });

  it("summarizes completed transfers and local changes", () => {
    const output = renderLibrarySync({
      status: "merged",
      snapshots_to_upload: 3,
      snapshots_to_download: 2,
      plan: { local: [], remote: [] },
      projection_conflicts: [{ skill: "review", path: "/skills/review" }],
    });
    expect(output).toContain("3 uploaded, 2 downloaded");
    expect(output).toContain("this device: no changes; remote: no changes");
    expect(output).toContain("needs review");
  });

  it("explains setup and sync are separate", () => {
    expect(setupStepPlan({ scanRepositories: false }).overview).toContain(
      "It does not sync your Library to a server",
    );
  });

  it("offers bounded explicit progress independently of terminal status", async () => {
    const lines: string[] = [];
    const progress = terminalSyncProgress(
      {
        withStatus: (_status, effect) => effect,
        updateStatus: () => Effect.void,
        progress: (line) => Effect.sync(() => void lines.push(line)),
      },
      true,
    );
    const phase = { kind: "upload" as const, total: 100 };
    await Effect.runPromise(progress.sync.around(phase, Effect.void));
    for (const completed of [0, 1, 10, 100])
      await Effect.runPromise(progress.sync.tick({ phase, completed }));
    expect(lines).toEqual([
      "Uploading 100 Skill copies",
      "Uploading 100 Skill copies · 0/100",
      "Uploading 100 Skill copies · 10/100",
      "Uploading 100 Skill copies · 100/100",
    ]);
  });
});
