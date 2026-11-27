import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const plugin = join(import.meta.dirname, "oxlint-plugin-skit.mjs");
const oxlint = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

/** Exercise the real oxlint parser and plugin with a repository path and isolated config. */
async function lint(
  rule: string,
  source: string,
  path = "packages/cli/src/author/probe.ts",
  filename?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "skit-frontend-rules-"));
  const file = join(root, path.replace("probe", `lint-probe-${process.pid}-${Date.now()}`));
  const config = join(directory, ".oxlintrc.json");
  try {
    const configuredPlugin = filename ? join(directory, "plugin.mjs") : plugin;
    if (filename)
      await writeFile(
        configuredPlugin,
        `import plugin from ${JSON.stringify(plugin)};
export default { meta: plugin.meta, rules: { ${JSON.stringify(rule)}: {
  ...plugin.rules[${JSON.stringify(rule)}], create(context) {
    return plugin.rules[${JSON.stringify(rule)}].create(new Proxy({}, {
      get(_, key) { return key === "filename" ? ${JSON.stringify(join(root, filename))} : Reflect.get(context, key); }
    }));
  }
} } };`,
      );
    await writeFile(
      config,
      JSON.stringify({
        jsPlugins: [configuredPlugin],
        rules: { [`skit/${rule}`]: "error" },
      }),
    );
    await writeFile(file, source);
    const result = spawnSync(
      process.execPath,
      [oxlint, "--config", config, "--format=json", file],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      diagnostics: Array<{
        code: string;
        labels: Array<{ span: { line: number } }>;
      }>;
    };
    expect(report.diagnostics.filter((item) => !item.code)).toEqual([]);
    return report.diagnostics
      .filter((item) => item.code.includes(rule))
      .map((item) => item.labels[0]?.span.line);
  } finally {
    await rm(file, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

describe("skit/atlas-tokens", () => {
  const path = "packages/storybook/web/src/components/probe.ts";
  const check = (source: string, filename?: string) =>
    lint("atlas-tokens", source, "lint/probe.ts", filename ?? path);

  test("resolves constants, branches, templates, arrays and closed lookup tables", async () => {
    expect(
      await check(`
const size = condition ? "body" : "caption";
const classes = ["grid gap-4", condition && "text-success", "font-heading"].join(" ");
h.Class(classes); h.Class("underline italic");
h.Class(\`text-\${size} p-4\`);
h.Class({ passed: "text-success", failed: "text-destructive" }[status]);
const { Class: cls } = h;
cls("text-title font-heading");
const alias = h.Class; alias("text-display font-display");
const props = { className: condition ? "text-body" : "text-caption", style: { display: "grid" } };
h.Attribute("class", "text-muted-foreground bg-background gap-0");
`),
    ).toEqual([]);
  });

  test("rejects arbitrary values, default scales and independent line heights", async () => {
    expect(
      await check(`
h.Class("text-[13px]");
h.Class("hover:text-red-500");
h.Class("gap-5");
h.Class("font-bold");
h.Class("rounded-lg");
h.Class("leading-5");
h.Class("text-body/6");
h.Class("bg-[color:#fff]");
h.Class("[&:hover]:text-[13px]");
h.Class("[color:red]");
h.Class("outline-offset-2");
h.Class("text-inherit");
`),
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  test("checks aliases, native attributes, computed properties and composed constants", async () => {
    expect(
      await check(`
const bad = "text-sm";
const cls = h.Class;
cls("grid " + bad);
const { Style: css } = h;
css({ fontSize: "13px" });
h.Attribute("style", "background-color: red; display: grid");
const key = "className";
const props = { [key]: \`p-4 \${bad}\` };
const styles = { color: "red" };
h.Style({ ...styles });
`),
    ).toEqual([4, 6, 7, 9, 10]);
  });

  test("fails closed on unresolved protected sinks", async () => {
    expect(
      await check(`
h.Class(input);
const props = { className: input, style: input };
h.Class(\`text-\${input}\`);
h.Attribute(attribute, input);
let choice = "text-body"; choice = input; h.Class(choice);
h.Style({ [property]: value });
`),
    ).toEqual([2, 3, 3, 4, 5, 6, 7]);
  });

  test("checks every owned view without a migration allowance", async () => {
    for (const filename of ["main.ts", "pages/overview.ts", "pages/command.ts"])
      expect(
        await check('h.Class("text-[13px]");', "packages/storybook/web/src/" + filename),
      ).toEqual([1]);
  });

  test("rejects new hand-written CSS through the entry's existing lint gate", async () => {
    const file = join(root, "packages/storybook/web/src/components/lint-probe.css");
    try {
      await writeFile(file, ".invented { color: red; }");
      expect(await check("const entry = true;", "packages/storybook/web/src/entry.ts")).toEqual([
        1,
      ]);
    } finally {
      await rm(file, { force: true });
    }
    expect(await check("const entry = true;", "packages/storybook/web/src/entry.ts")).toEqual([]);
  });

  test("rejects arbitrary body utilities and inline HTML styling", async () => {
    const file = join(root, "packages/storybook/web/index.html");
    const original = await readFile(file, "utf8");
    try {
      for (const body of ['<body class="text-[13px]">', '<body style="color:red">']) {
        await writeFile(file, original.replace(/<body[^>]*>/, body));
        expect(await check("const entry = true;", "packages/storybook/web/src/entry.ts")).toEqual([
          1,
        ]);
      }
    } finally {
      await writeFile(file, original);
    }
  });

  test("rejects shorthand colours and mutable or cyclic compositions", async () => {
    for (const source of [
      'h.Style({ outline: "1px solid red" });',
      'h.Style({ backgroundImage: "linear-gradient(red, blue)" });',
      'h.Style({ boxShadow: "0 1px red" });',
      'const styles = {}; styles.color = "red"; h.Style(styles);',
      'const classes = ["text-body"]; classes.push(input); h.Class(classes.join(" "));',
      "const a = b; const b = a; h.Class(a);",
      'h.Class({ ...input, good: "text-body" }[key]);',
    ])
      expect(await check(source)).not.toEqual([]);
  });

  test("leaves vendored components and the terminal renderer outside the rule", async () => {
    for (const filename of ["fluid/components/badge/view.ts", "components/terminal-frame.ts"])
      expect(
        await check('h.Class("text-[13px] rounded-lg");', "packages/storybook/web/src/" + filename),
      ).toEqual([]);
  });
});
