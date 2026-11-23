import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

// D1 rejects integrity_check. Exercise the same SQL in native SQLite for the full check.
const directory = new URL("../migrations/", import.meta.url);
test.each([false, true])("revision migration integrity, seeded old graph: %s", (seed) => {
  const db = new DatabaseSync(":memory:");
  try {
    const names = readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of names) {
      if (name.startsWith("0012_") && seed) {
        db.exec(`
          INSERT INTO skits VALUES ('alice','tools','private','rev7','created','updated',NULL);
          INSERT INTO revision_trees VALUES ('tree');
          INSERT INTO revision_tree_entries VALUES ('tree','notes','file',420,'blob',4,NULL);
          INSERT INTO releases (owner_slug,skit_slug,version,release_id,source_revision,archive_digest,archive_bytes,archive_object_key,published_at,visibility)
            VALUES ('alice','tools','1.0.0','release','rev7','hash',4,'archive','then','public');
        `);
        for (let index = 0; index < 8; index++) {
          db.prepare(
            "INSERT INTO revisions VALUES ('alice','tools',?,'tree','device',?,'null','[]',NULL,'then')",
          ).run(`rev${index}`, index);
          if (index)
            db.prepare("INSERT INTO revision_parents VALUES ('alice','tools',?,0,?)").run(
              `rev${index}`,
              `rev${index - 1}`,
            );
        }
      }
      db.exec("BEGIN");
      db.exec(readFileSync(new URL(name, directory), "utf8"));
      db.exec("COMMIT");
    }
    for (const table of [
      "revisions",
      "revision_parents",
      "revision_trees",
      "revision_tree_entries",
    ]) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count).toBe(0);
    }
    if (seed) {
      expect(
        db.prepare("SELECT current_revision_id FROM skits").get().current_revision_id,
      ).toBeNull();
      expect(db.prepare("SELECT source_revision FROM releases").get().source_revision).toBeNull();
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  } finally {
    db.close();
  }
});
