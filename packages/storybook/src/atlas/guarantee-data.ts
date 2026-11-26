import { Effect } from "effect";
import { collectGuarantees } from "./guarantee-catalog.ts";
import { commandGuarantees } from "./guarantees.ts";
import { copyIssues } from "./copy-issues.ts";
import { readTestReports } from "./test-reports.ts";

/** Both generation paths validate the same declarations before publishing the index. */
export async function guaranteeData(root: string) {
  const guaranteeFiles = await collectGuarantees(root);
  const testReports = await Effect.runPromise(readTestReports(root));
  const data = { guaranteeFiles, testReports };
  const commands = new Set(
    guaranteeFiles.flatMap((file) => file.tests.map((test) => test.ancestorTitles[0]!.slice(5))),
  );
  for (const command of commands) {
    for (const group of commandGuarantees(data, command)) {
      for (const issue of copyIssues(group.title))
        console.warn(
          `Atlas guarantee copy (${command}, ${group.tests[0]?.file}): ${issue.kind} "${issue.text}" in "${group.title}"`,
        );
    }
  }
  return data;
}
