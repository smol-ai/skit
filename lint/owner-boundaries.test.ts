import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { approvedServices, debt, owners, serviceDebt } from "../architecture/boundaries.mjs";

const root = join(import.meta.dirname, "..");
const pluginPath = join(import.meta.dirname, "oxlint-plugin-skit.mjs");
const oxlintPath = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

/** Lints one file outside every owner and returns the first word of each report from `rule`. */
async function reported(
  source: string | ((directory: string) => string),
  rule = "owner-boundaries",
): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "skit-owner-boundaries-"));
  const file = join(directory, "handler.ts");
  await writeFile(file, typeof source === "string" ? source : source(directory));
  await writeFile(
    join(directory, ".oxlintrc.json"),
    JSON.stringify({ jsPlugins: [pluginPath], rules: { [`skit/${rule}`]: "error" } }),
  );
  const result = spawnSync(
    process.execPath,
    [oxlintPath, "--config", join(directory, ".oxlintrc.json"), "--format=json", file],
    { encoding: "utf8", cwd: root },
  );
  const report = JSON.parse(result.stdout) as {
    diagnostics: Array<{ code: string; message: string }>;
  };
  return report.diagnostics
    .filter((item) => item.code.includes(rule))
    .map((item) => item.message.split(" ")[0] ?? "");
}

describe("skit/owner-boundaries", () => {
  test("a handler cannot open the Library's store or writer", async () => {
    expect(
      await reported(`import { LibraryStore, withLibraryWriter } from "@smolai/skit-core";`),
    ).toEqual(["LibraryStore", "withLibraryWriter"]);
  });

  test("re-exporting a private name is the same bypass", async () => {
    expect(await reported(`export { libraryStoreLayer } from "@smolai/skit-core";`)).toEqual([
      "libraryStoreLayer",
    ]);
  });

  test("calling the owner is allowed", async () => {
    expect(await reported(`import { Library, InstalledSkills } from "@smolai/skit-core";`)).toEqual(
      [],
    );
  });

  test("a handler cannot write author state around AuthorWorkspace or AuthorHistory", async () => {
    const module = (directory: string, path: string) =>
      relative(directory, join(root, "packages/cli/src", `${path}.js`));
    expect(
      await reported(
        (directory) =>
          `import { mintPreparedWrite } from "${module(directory, "author/workspace")}";
import { writeWorkspaceTree } from "${module(directory, "author/write-tree")}";
import { withDeviceStore } from "${module(directory, "workflows/author/device-store")}";`,
      ),
    ).toEqual(["mintPreparedWrite", "writeWorkspaceTree", "withDeviceStore"]);
  });

  test("debt only shrinks: every listed violation still exists", async () => {
    const stale: string[] = [];
    const privateNames = new Set(owners.flatMap((owner) => owner.private));
    for (const [file, names] of Object.entries(debt)) {
      const text = await readFile(join(root, file), "utf8").catch(() => "");
      const specifiers = [...text.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from/g)]
        .flatMap((match) => (match[1] ?? "").split(","))
        .map((specifier) =>
          specifier
            .replace(/\btype\s+/, "")
            .split(" as ")[0]
            ?.trim(),
        );
      for (const name of names) {
        if (!privateNames.has(name)) stale.push(`${file}: ${name} is not a private name`);
        else if (!specifiers.includes(name)) stale.push(`${file}: ${name}`);
      }
    }
    expect(
      stale,
      "Remove these from architecture/boundaries.mjs: the code no longer needs them",
    ).toEqual([]);
  });
});

describe("skit/approved-services", () => {
  test("a new coordinator service is rejected", async () => {
    expect(
      await reported(
        `import { Context } from "effect";
class AuthorSync extends Context.Service<AuthorSync, {}>()("skit/AuthorSync") {}`,
        "approved-services",
      ),
    ).toEqual(["skit/AuthorSync"]);
  });

  test("a new context reference is rejected", async () => {
    expect(
      await reported(
        `import { Context } from "effect";
export const Flag = Context.Reference<boolean>("skit/Flag", { defaultValue: () => false });`,
        "approved-services",
      ),
    ).toEqual(["skit/Flag"]);
  });

  test("an approved owner is allowed", async () => {
    expect(
      await reported(
        `import { Context } from "effect";
class Library extends Context.Service<Library, {}>()("skit/library/Library") {}`,
        "approved-services",
      ),
    ).toEqual([]);
  });

  test("service debt only shrinks: every listed service is still declared", async () => {
    const { execFileSync } = await import("node:child_process");
    const declared = execFileSync("git", ["grep", "-h", "-o", "-E", '"[^"]+"', "--", "packages"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const strings = new Set(declared.split("\n").map((line) => line.slice(1, -1)));
    const stale = Object.keys(serviceDebt).filter((id) => !strings.has(id));
    const overlap = Object.keys(serviceDebt).filter((id) => approvedServices.includes(id));
    expect({ stale, overlap }).toEqual({ stale: [], overlap: [] });
  });
});
