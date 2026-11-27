import type { Atlas } from "./data.ts";
import type { Guarantee } from "./guarantee-metadata.ts";

/** Command membership and guarantee wording come from native Vitest metadata or nested describe groups. */
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
  const ranked = new Map<string, number>();
  const currentFiles = atlas.testReports
    .filter((report) => report.provenance === "current")
    .flatMap((report) => report.files);
  const testKey = (
    file: string,
    ancestry: readonly string[],
    title: string,
    guarantee?: Guarantee,
  ) =>
    JSON.stringify(
      guarantee
        ? [file, { command: guarantee.command, key: guarantee.key }, title]
        : [file, ...ancestry, title],
    );
  const results = new Map(
    currentFiles.flatMap((file) =>
      file.tests.map(
        (test) =>
          [
            testKey(file.file, test.ancestorTitles, test.title, test.guarantee),
            test.status,
          ] as const,
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
      if (test.guarantee) {
        const order = test.guarantee.sectionOrder;
        if (ranked.has(section) && ranked.get(section) !== order)
          throw new Error(`Conflicting sectionOrder for skit ${command}: ${section}`);
        ranked.set(section, order);
      }
      if (!sectionOrder.has(section)) sectionOrder.set(section, new Set());
      // Separate describe blocks can revisit a section. Its first appearance
      // declares its position; a later block adds tests, not a reverse edge.
      if (!seenSections.has(section)) {
        if (previousSection !== undefined) sectionOrder.get(previousSection)!.add(section);
        seenSections.add(section);
        previousSection = section;
      }
      const key = test.guarantee
        ? JSON.stringify({ command, key: test.guarantee.key })
        : JSON.stringify([...sections, title]);
      let group = groups.get(key);
      if (group === undefined) {
        group = { key, sections, title, tests: [] };
        groups.set(key, group);
      }
      group.tests.push({
        file: file.file,
        test: {
          ...test,
          status:
            results.get(testKey(file.file, test.ancestorTitles, test.title, test.guarantee)) ??
            results.get(testKey(file.file, test.ancestorTitles, test.title)),
        },
      });
    }
  }
  // Merge the section order declared by each file; no page owns the section names or count.
  const canonical = [...ranked.keys()].sort(
    (a, b) => ranked.get(a)! - ranked.get(b)! || a.localeCompare(b),
  );
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
