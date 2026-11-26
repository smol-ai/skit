import { join, relative } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { testSource } from "./test-source.ts";
import { NodeFileSystem } from "@effect/platform-node";

// Decode only the fields Atlas needs from Vitest's standard JSON report.
const Report = Schema.fromJsonString(
  Schema.Struct({
    startTime: Schema.Finite,
    source: Schema.optionalKey(Schema.Struct({ revision: Schema.String, dirty: Schema.Boolean })),
    testResults: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        assertionResults: Schema.Array(
          Schema.Struct({
            fullName: Schema.String,
            title: Schema.String,
            ancestorTitles: Schema.Array(Schema.String),
            status: Schema.Literals(["passed", "failed", "skipped", "pending", "todo", "disabled"]),
          }),
        ),
      }),
    ),
  }),
);

/** Saved runs are independent of the build: missing reports are displayed as missing. */
export const readTestReports = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const reports = [];
    let current: ReturnType<typeof testSource> | undefined;
    for (const pkg of ["cli", "skit"]) {
      const path = join(root, "packages", pkg, ".atlas", "vitest.json");
      const contents = yield* fs.readFileString(path).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.undefined,
        ),
      );
      if (contents === undefined) continue;
      const report = yield* Schema.decodeEffect(Report)(contents);
      if (report.source !== undefined) current ??= testSource(root);
      reports.push({
        package: pkg,
        startTime: report.startTime,
        ...(report.source === undefined ? {} : { source: report.source }),
        provenance:
          report.source === undefined || report.source.dirty || !current || current.dirty
            ? ("unverified" as const)
            : report.source.revision === current.revision
              ? ("current" as const)
              : ("stale" as const),
        files: report.testResults
          .flatMap((file) => {
            const name = relative(root, file.name).replaceAll("\\", "/");
            if (!name.startsWith(`packages/${pkg}/test/`)) return [];
            return [
              {
                file: name,
                tests: file.assertionResults.map((test) => ({
                  name: test.fullName,
                  title: test.title,
                  ancestorTitles: test.ancestorTitles,
                  status:
                    test.status === "pending" || test.status === "disabled"
                      ? "skipped"
                      : test.status,
                })),
              },
            ];
          })
          .sort((left, right) => left.file.localeCompare(right.file)),
      });
    }
    return reports;
  }).pipe(Effect.provide(NodeFileSystem.layer));
