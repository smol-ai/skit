import { relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Collect declarations without running test bodies. Collection expands parameterized tests
 * and scenario helpers with the same names Vitest writes to its saved reports. */
export async function collectGuarantees(root: string) {
  const files = [];
  for (const project of ["cli", "skit"]) {
    const packageRoot = resolve(root, "packages", project);
    // Use the same Vitest instance as the test helpers in this package.
    const runner = createRequire(resolve(packageRoot, "package.json")).resolve("vitest/node");
    const { createVitest }: typeof import("vitest/node") = await import(pathToFileURL(runner).href);
    const context = await createVitest({
      root: packageRoot,
      config: resolve(root, "vitest.atlas.config.ts"),
      project: [project],
      watch: false,
    });

    try {
      const { testModules, unhandledErrors } = await context.collect([], { staticParse: false });
      if (unhandledErrors.length)
        throw new AggregateError(unhandledErrors, "Atlas test collection failed");
      files.push(
        ...testModules.flatMap((module) => {
          const errors = module.errors();
          if (errors.length)
            throw new Error(
              `Cannot collect ${module.moduleId}: ${errors.map((e) => e.message).join(", ")}`,
            );
          const tests = [];
          for (const test of module.children.allTests()) {
            const ancestorTitles = [];
            for (let parent = test.parent; parent.type === "suite"; parent = parent.parent)
              ancestorTitles.unshift(parent.name);
            if (ancestorTitles.length >= 2 && ancestorTitles[0]!.startsWith("skit "))
              tests.push({ title: test.name, ancestorTitles });
          }
          return tests.length
            ? [{ file: relative(root, module.moduleId).replaceAll("\\", "/"), tests }]
            : [];
        }),
      );
    } finally {
      await context.close();
    }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
