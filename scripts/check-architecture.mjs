import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Decode literal policy data without executing a candidate module. */
export function policy(parse, source) {
  const value = (node) => {
    if (node.type === "Literal") return node.value;
    if (node.type === "ArrayExpression") return node.elements.map(value);
    if (node.type === "ObjectExpression")
      return Object.fromEntries(
        node.properties.map((entry) => {
          if (entry.type !== "Property" || entry.computed || entry.method || entry.kind !== "init")
            throw new Error("Architecture policy must contain literal data only");
          return [entry.key.name ?? entry.key.value, value(entry.value)];
        }),
      );
    throw new Error("Architecture policy must contain literal data only");
  };
  return Object.fromEntries(
    parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.flatMap((statement) => {
      if (
        statement.type !== "ExportNamedDeclaration" ||
        statement.declaration?.type !== "VariableDeclaration"
      )
        throw new Error("Architecture policy must contain exported literal constants only");
      return statement.declaration.declarations.map((entry) => {
        if (entry.id.type !== "Identifier")
          throw new Error("Architecture policy must use named constants");
        return [entry.id.name, value(entry.init)];
      });
    }),
  );
}

export function newAllowances(before, after, path = "debt") {
  if (Array.isArray(before) && Array.isArray(after))
    return after.flatMap((value) => (before.includes(value) ? [] : [`${path}: added ${value}`]));
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  )
    return Object.entries(after).flatMap(([key, value]) =>
      Object.hasOwn(before, key)
        ? newAllowances(before[key], value, `${path}.${key}`)
        : [`${path}: added ${key}`],
    );
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [`${path}: changed allowance`];
}

export function comparePolicy(before, after, shrinking) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
    shrinking.includes(key)
      ? newAllowances(before[key], after[key], key)
      : JSON.stringify(before[key]) === JSON.stringify(after[key])
        ? []
        : [`${key}: approved rule changed`],
  );
}

export function check(root, base) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const revision = git("rev-parse", "--verify", `${base}^{commit}`).trim();
  const tracked = new Set(git("ls-tree", "-r", "--name-only", revision).trim().split("\n"));
  const before = (file) => git("show", `${revision}:${file}`);
  const after = (file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const { parse } = createRequire(join(root, "packages/skit/package.json"))("acorn");
  const failures = [];
  for (const [file, shrinking] of [
    ["architecture/boundaries.mjs", ["debt", "serviceDebt"]],
    ["architecture/layout.mjs", ["layoutDebt", "importDebt"]],
  ]) {
    const current = after(file);
    if (current === undefined) failures.push(`${file}: policy removed`);
    else
      failures.push(
        ...comparePolicy(policy(parse, before(file)), policy(parse, current), shrinking).map(
          (failure) => `${file}: ${failure}`,
        ),
      );
  }
  for (const file of tracked) {
    if (
      (file.startsWith("architecture/") && !file.endsWith(".mjs")) ||
      file.startsWith("lint/") ||
      [".oxlintrc.json", "vitest.lint.config.ts", "scripts/check-architecture.mjs"].includes(file)
    ) {
      if (before(file) !== after(file))
        failures.push(`${file}: contract or enforcement changed; review separately`);
    }
  }
  const changed = new Set([
    ...git("diff", "--name-only", revision).trim().split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").trim().split("\n"),
  ]);
  for (const file of changed) {
    if (
      /(?:^|\/)(?:\.oxlintrc\.[^/]+|eslint\.config\.[^/]+)$/.test(file) &&
      (!tracked.has(file) || before(file) !== after(file))
    ) {
      failures.push(`${file}: lint configuration changed; review separately`);
    }
  }
  const suppressions = (source) => source?.match(/(?:oxlint|eslint)-disable[^\r\n]*/g) ?? [];
  for (const file of changed)
    if (/\.[cm]?[jt]sx?$/.test(file))
      failures.push(
        ...newAllowances(
          suppressions(tracked.has(file) ? before(file) : ""),
          suppressions(after(file)),
          `${file}: suppressions`,
        ),
      );
  return { baseline: revision, status: failures.length ? "FAIL" : "PASS", failures };
}

if (
  process.argv[1] === "-" ||
  (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  try {
    const base = option("--base");
    if (!base)
      throw new Error(
        "Usage: node check-architecture.mjs --base <approved-commit> [--root <checkout>]",
      );
    const result = check(resolve(option("--root") ?? process.cwd()), base);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "PASS" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
