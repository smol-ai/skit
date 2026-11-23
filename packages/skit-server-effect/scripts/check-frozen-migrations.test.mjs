import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { checkFrozenMigrations } from "./check-frozen-migrations.ts";

const directory = "packages/skit-server-effect/migrations";
for (const change of ["unchanged", "add", "edit", "delete", "rename", "target-advanced"]) {
  test(`frozen migrations: ${change}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "skit-migration-guard-"));
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const save = () => {
      git("add", ".");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
    };
    try {
      git("init", "-q");
      mkdirSync(join(cwd, directory), { recursive: true });
      const old = join(cwd, directory, "0010_owner_schema.sql");
      writeFileSync(old, "SELECT 1;\n");
      save();
      let base = git("rev-parse", "HEAD");
      if (change === "add")
        writeFileSync(join(cwd, directory, "0012_revision_edit_times.sql"), "SELECT 2;\n");
      if (change === "edit") writeFileSync(old, "SELECT 3;\n");
      if (change === "delete") rmSync(old);
      if (change === "rename") renameSync(old, join(cwd, directory, "0012_renamed.sql"));
      if (change === "target-advanced") {
        git("branch", "feature");
        writeFileSync(join(cwd, directory, "0011_target.sql"), "SELECT 2;\n");
        save();
        base = git("rev-parse", "HEAD");
        git("switch", "-q", "feature");
      }
      writeFileSync(join(cwd, "feature.txt"), "feature\n");
      save();
      const result = await Effect.runPromise(Effect.result(checkFrozenMigrations(cwd, base)));
      if (["edit", "delete", "rename"].includes(change)) {
        expect(result._tag).toBe("Failure");
        expect(result.failure.message).toContain(`${directory}/0010_owner_schema.sql`);
      } else expect(result._tag).toBe("Success");
      const command = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./check-frozen-migrations.ts", import.meta.url)), base],
        { cwd, encoding: "utf8" },
      );
      expect(command.status, command.stderr).toBe(result._tag === "Success" ? 0 : 1);
      const missing = await Effect.runPromise(
        Effect.result(checkFrozenMigrations(cwd, "missing-ref")),
      );
      expect(missing._tag).toBe("Failure");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test.each([undefined, "", "0000000000000000000000000000000000000000"])(
  "missing comparison base fails: %s",
  async (base) => {
    const result = await Effect.runPromise(
      Effect.result(checkFrozenMigrations(process.cwd(), base)),
    );
    expect(result._tag).toBe("Failure");
  },
);
