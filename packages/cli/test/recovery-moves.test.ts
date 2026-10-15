import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { LinkStat, skitLayer } from "@smolai/skit-core";
import { prepareRecoveryMoves } from "../src/library-application/recovery-moves.js";
import { scratch } from "./helpers/library-home.js";

it.effect.each(["prepare", "apply"] as const)(
  "refuses a retargeted approved alias during %s without moving either source",
  (phase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const links = yield* LinkStat;
      const root = yield* scratch("skit-recovery-moves-");
      const source = join(root, "source");
      const other = join(root, "other");
      const alias = join(root, "alias");
      for (const path of [source, other]) {
        yield* fs.makeDirectory(path);
        yield* fs.writeFileString(join(path, "SKILL.md"), path);
      }
      yield* fs.symlink(source, alias);
      const info = yield* links.identity.lstat(alias);
      const request = {
        name: "review",
        path: alias,
        approvedLink: { dev: info.dev, ino: info.ino, linkTarget: source },
      };
      const prepared = phase === "apply" ? yield* prepareRecoveryMoves(root, [request]) : undefined;
      // Keep the original inode alive so a replacement cannot reuse it.
      yield* fs.rename(alias, `${alias}-approved`);
      yield* fs.symlink(other, alias);
      const failure = yield* Effect.flip(
        prepared ? prepared.apply() : prepareRecoveryMoves(root, [request]),
      );
      expect(failure._tag).toBe("PlanIsStale");
      expect(yield* fs.readLink(alias)).toBe(other);
      expect(yield* fs.readLink(`${alias}-approved`)).toBe(source);
      for (const path of [source, other])
        expect(yield* fs.readFileString(join(path, "SKILL.md"))).toBe(path);
      expect(yield* fs.exists(join(root, "removed"))).toBe(false);
    }).pipe(Effect.provide(skitLayer)),
);
