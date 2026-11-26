import type { Atlas } from "./data.ts";
import syncSections from "../../../../test-support/sync-guarantees.json" with { type: "json" };

/** Command membership and guarantee wording come only from the real test's describe groups. */
export const commandGuarantees = (
  atlas: Pick<Atlas, "guaranteeFiles" | "testReports">,
  command: string,
) => {
  const groups = new Map<
    string,
    {
      key: string;
      sections: string[];
      title: string;
      tests: Array<{
        file: string;
        test: {
          title: string;
          ancestorTitles: readonly string[];
          status?: Atlas["testReports"][number]["files"][number]["tests"][number]["status"];
        };
      }>;
    }
  >();
  const sectionOrder = new Map<string, Set<string>>();
  const currentFiles = atlas.testReports
    .filter((report) => report.provenance === "current")
    .flatMap((report) => report.files);
  const testKey = (file: string, ancestry: readonly string[], title: string) =>
    JSON.stringify([file, ...ancestry, title]);
  const results = new Map(
    currentFiles.flatMap((file) =>
      file.tests.map(
        (test) => [testKey(file.file, test.ancestorTitles, test.title), test.status] as const,
      ),
    ),
  );
  for (const file of atlas.guaranteeFiles ?? currentFiles) {
    let previousSection: string | undefined;
    const seenSections = new Set<string>();
    for (const test of file.tests) {
      if (test.ancestorTitles[0] !== `skit ${command}`) continue;
      if (test.ancestorTitles.length < 2) continue;
      const title = test.ancestorTitles.at(-1)!;
      const sections = test.ancestorTitles.slice(1, -1);
      const section = JSON.stringify(sections);
      if (!sectionOrder.has(section)) sectionOrder.set(section, new Set());
      // Separate describe blocks can revisit a section. Its first appearance
      // declares its position; a later block adds tests, not a reverse edge.
      if (!seenSections.has(section)) {
        if (previousSection !== undefined) sectionOrder.get(previousSection)!.add(section);
        seenSections.add(section);
        previousSection = section;
      }
      const key = JSON.stringify([...sections, title]);
      let group = groups.get(key);
      if (group === undefined) {
        group = { key, sections, title, tests: [] };
        groups.set(key, group);
      }
      group.tests.push({
        file: file.file,
        test: { ...test, status: results.get(testKey(file.file, test.ancestorTitles, test.title)) },
      });
    }
  }
  // Merge the section order declared by each file; no page owns the section names or count.
  // Sync has a shared authoring catalog, so its file registration order is immaterial.
  const canonical =
    command === "sync" ? Object.keys(syncSections).map((section) => JSON.stringify([section])) : [];
  const remaining = [...sectionOrder.keys()].filter((key) => !canonical.includes(key));
  const ordered: string[] = [...canonical];
  while (remaining.length > 0) {
    const next = remaining.find(
      (key) => !remaining.some((other) => sectionOrder.get(other)!.has(key)),
    );
    if (next === undefined)
      throw new Error(
        `Conflicting test section order for skit ${command}: ${remaining.join(", ")}`,
      );
    ordered.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return [...groups.values()].sort(
    (left, right) =>
      ordered.indexOf(JSON.stringify(left.sections)) -
      ordered.indexOf(JSON.stringify(right.sections)),
  );
};
