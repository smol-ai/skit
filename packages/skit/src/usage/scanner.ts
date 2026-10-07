import { Context, DateTime, Effect, FileSystem, Layer, Option, Stream } from "effect";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { LinkStat } from "../platform/link-stat.js";
import { extractUsage, object, type UsageEvent, type ExtractedUsage } from "./events.js";
import {
  InvalidUsageOptions,
  type UsageCoverage,
  type UsageOptions,
  type UsageProjection,
  type UsageReport,
  type UsageRow,
} from "./contracts.js";

export const MAX_USAGE_LINE_BYTES = 16 * 1024 * 1024;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Coverage = Mutable<UsageCoverage>;
interface SourceFile {
  path: string;
  size: number;
  modified: number;
  coverage: Coverage;
}
interface Observation {
  event: UsageEvent;
  timestamp: string;
  cwd?: string;
  coverage: Coverage;
}
const fingerprint = (s: string) => createHash("sha256").update(s).digest("hex");
const blank = (h: UsageCoverage["harness"], root: string): Coverage => ({
  harness: h,
  root,
  status: "available",
  files: 0,
  bytes: 0,
  bytesRead: 0,
  records: 0,
  windowRecords: 0,
  malformed: 0,
  undated: 0,
  undatedCandidates: 0,
  unsupported: 0,
  duplicates: 0,
  missingIds: 0,
  summaries: 0,
  mentions: 0,
  slashCommands: 0,
  oversizedLines: 0,
  skippedFiles: 0,
  unreadableFiles: 0,
  changedFiles: 0,
  unknownProjectRecords: 0,
});

export class SkillUsage extends Context.Service<
  SkillUsage,
  {
    readonly scan: (options: UsageOptions) => Effect.Effect<UsageReport, InvalidUsageOptions>;
  }
>()("skit/SkillUsage") {}

export const skillUsageLayer = Layer.effect(
  SkillUsage,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const links = yield* LinkStat;
    const physical = Effect.fn("SkillUsage.physical")(function* (file: string) {
      return yield* links.realPathNative(file).pipe(Effect.orElseSucceed(() => file));
    });
    const scan = Effect.fn("SkillUsage.scan")(function* (options: UsageOptions) {
      const began = yield* DateTime.now;
      const clockStart = DateTime.toEpochMillis(began);
      const end = options.end === undefined ? clockStart : Date.parse(options.end);
      const days = options.days ?? 7;
      if (!Number.isFinite(end) || !Number.isInteger(days) || days < 1 || days > 3650)
        return yield* new InvalidUsageOptions({
          message: "Use a valid end timestamp and a whole number of days between 1 and 3650.",
        });
      const start = end - days * 86400000;
      if (options.project !== undefined) {
        const info = yield* fs.stat(resolve(options.project)).pipe(
          Effect.catch(() =>
            Effect.fail(
              new InvalidUsageOptions({
                message: "The project must be an accessible directory.",
              }),
            ),
          ),
        );
        if (info.type !== "Directory")
          return yield* new InvalidUsageOptions({ message: "The project must be a directory." });
      }
      const project =
        options.project === undefined ? null : yield* physical(resolve(options.project));

      const coverage = options.roots.map((r) => blank(r.harness, resolve(r.root)));
      const files: SourceFile[] = [];
      const directoryKeys = new Set<string>();
      const walk = Effect.fn("SkillUsage.discover")(function* (
        dir: string,
        c: Coverage,
        isRoot = false,
      ): Effect.fn.Return<void> {
        const info = yield* links.lstat(dir).pipe(
          Effect.catch((error) => {
            if (isRoot) c.status = error.reason._tag === "NotFound" ? "missing" : "unreadable";
            else c.unreadableFiles++;
            return Effect.succeed(undefined);
          }),
        );
        if (!info) return;
        if (info.type === "SymbolicLink") {
          c.skippedFiles++;
          return;
        }
        if (info.type === "File") {
          if (dir.endsWith(".jsonl")) {
            const snapshot = yield* fs.stat(dir).pipe(
              Effect.catch(() => {
                c.unreadableFiles++;
                return Effect.succeed(undefined);
              }),
            );
            if (!snapshot) return;
            const size = Number(snapshot.size);
            c.files++;
            c.bytes += size;
            files.push({
              path: dir,
              size,
              modified: Option.match(snapshot.mtime, {
                onNone: () => 0,
                onSome: (d) => d.getTime(),
              }),
              coverage: c,
            });
          } else if (dir.endsWith(".jsonl.zst")) c.skippedFiles++;
          return;
        }
        if (info.type !== "Directory") {
          c.skippedFiles++;
          return;
        }
        if (directoryKeys.has(dir)) {
          c.skippedFiles++;
          return;
        }
        directoryKeys.add(dir);
        const names = yield* fs.readDirectory(dir).pipe(
          Effect.catch(() => {
            if (isRoot) c.status = "unreadable";
            else c.unreadableFiles++;
            return Effect.succeed([]);
          }),
        );
        for (const name of names.sort()) yield* walk(join(dir, name), c);
      });
      for (const c of coverage) yield* walk(c.root, c, true);
      const observations: Observation[] = [];
      let completed = 0;
      for (const file of files) {
        const c = file.coverage;
        let cwd: string | undefined;
        let observedBytes = 0;
        let pieces: Buffer[] = [];
        let length = 0;
        let dropping = false;
        const pending: { cwd?: string; timestamp: string; extracted: ExtractedUsage }[] = [];
        const projectCwds = new Map<string, string>();
        const flushPending = Effect.fn("SkillUsage.projectRecords")(function* () {
          for (const record of pending) {
            let recordCwd = record.cwd;
            if (project !== null) {
              if (!recordCwd) {
                c.unknownProjectRecords++;
                continue;
              }
              let canonical = projectCwds.get(recordCwd);
              if (!canonical) {
                canonical = yield* physical(recordCwd);
                projectCwds.set(recordCwd, canonical);
              }
              if (canonical !== project) continue;
              recordCwd = canonical;
            }
            c.windowRecords++;
            const extracted = record.extracted;
            c.unsupported += extracted.unsupported;
            c.summaries += extracted.summaries;
            c.mentions += extracted.mentions;
            c.slashCommands += extracted.slashCommands;
            for (const event of extracted.events)
              observations.push({
                event,
                timestamp: record.timestamp,
                cwd: recordCwd,
                coverage: c,
              });
          }
          pending.length = 0;
        });
        const consume = (bytes: Buffer) => {
          if (!bytes.length) return;
          let raw: unknown;
          try {
            raw = JSON.parse(bytes.toString("utf8"));
          } catch {
            c.malformed++;
            return;
          }
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
            c.malformed++;
            return;
          }
          const r = object(raw);
          c.records++;
          const p = object(r.payload);
          const nativeCwd =
            typeof r.cwd === "string"
              ? r.cwd
              : (r.type === "session_meta" || r.type === "turn_context") &&
                  typeof p.cwd === "string"
                ? p.cwd
                : undefined;
          if (nativeCwd && isAbsolute(nativeCwd)) cwd = nativeCwd;
          const stamp = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
          if (!Number.isFinite(stamp)) {
            c.undated++;
            c.undatedCandidates += extractUsage(c.harness, r).events.length;
            return;
          }
          if (stamp < start || stamp >= end) return;
          pending.push({
            cwd,
            timestamp: new Date(stamp).toISOString(),
            extracted: extractUsage(c.harness, r),
          });
        };
        const segment = (part: Buffer, finished: boolean) => {
          if (!dropping) {
            length += part.length;
            if (length > MAX_USAGE_LINE_BYTES) {
              dropping = true;
              c.oversizedLines++;
              pieces = [];
            } else if (part.length) pieces.push(part);
          }
          if (finished) {
            if (!dropping) consume(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, length));
            pieces = [];
            length = 0;
            dropping = false;
          }
        };
        yield* fs.stream(file.path, { chunkSize: 256 * 1024, bytesToRead: file.size }).pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              observedBytes += chunk.length;
              c.bytesRead += chunk.length;
              const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
              let begin = 0;
              let end;
              while ((end = bytes.indexOf(10, begin)) !== -1) {
                segment(bytes.subarray(begin, end), true);
                begin = end + 1;
              }
              segment(bytes.subarray(begin), false);
            }).pipe(Effect.andThen(flushPending())),
          ),
          Effect.catch(() => {
            c.unreadableFiles++;
            return Effect.void;
          }),
        );
        if (pieces.length && !dropping) consume(Buffer.concat(pieces, length));
        yield* flushPending();
        const after = yield* fs.stat(file.path).pipe(Effect.orElseSucceed(() => undefined));
        if (
          !after ||
          Number(after.size) !== file.size ||
          observedBytes !== file.size ||
          Option.match(after.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }) !==
            file.modified
        )
          c.changedFiles++;
        completed++;
        if (options.progress) yield* options.progress(completed, files.length);
      }
      // Resolve only the small observed identity set, never every advertised skill.
      const projections = new Map<string, UsageProjection[]>();
      for (const projection of options.projections ?? []) {
        const document = projection.path.endsWith("/SKILL.md")
          ? projection.path
          : join(projection.path, "SKILL.md");
        for (const key of new Set([resolve(document), yield* physical(resolve(document))])) {
          const values = projections.get(key) ?? [];
          if (!values.some((v) => v.skillId === projection.skillId)) values.push(projection);
          projections.set(key, values);
        }
      }
      const identities = new Map<
        string,
        {
          path: string | null;
          identity: UsageRow["identity"];
          skillId: string | null;
          name: string;
        }
      >();
      const rows = new Map<string, Mutable<UsageRow>>();
      const seen = new Set<string>();
      for (const observation of observations) {
        const { event, cwd, timestamp, coverage: c } = observation;
        const rawPath = event.path;
        const working =
          event.cwd && cwd
            ? resolve(cwd, event.cwd)
            : event.cwd && isAbsolute(event.cwd)
              ? event.cwd
              : cwd;
        const lexical =
          rawPath &&
          (isAbsolute(rawPath)
            ? resolve(rawPath)
            : working
              ? resolve(working, rawPath)
              : undefined);
        const identityKey = lexical ?? `name:${event.name}:${rawPath ?? ""}`;
        let identity = identities.get(identityKey);
        if (!identity) {
          const canonical = lexical ? yield* physical(lexical) : null;
          const matches = canonical
            ? (projections.get(canonical) ?? projections.get(lexical ?? "") ?? [])
            : [];
          const match = matches.length === 1 ? matches[0] : undefined;
          identity = {
            path: canonical,
            skillId: match?.skillId ?? null,
            name: match?.name ?? event.name,
            identity:
              matches.length > 1
                ? "ambiguous"
                : match
                  ? "managed"
                  : canonical && /(?:^|\/)skills\//.test(canonical)
                    ? "unmanaged"
                    : rawPath
                      ? "unresolved"
                      : "name-only",
          };
          identities.set(identityKey, identity);
        }
        if (!event.id) c.missingIds++;
        const stable = identity.skillId ?? identity.path ?? identityKey;
        const replay = fingerprint(`${c.harness}:${event.kind}:${event.id ?? timestamp}:${stable}`);
        if (seen.has(replay)) {
          c.duplicates++;
          continue;
        }
        seen.add(replay);
        const key = `${c.harness}:${identity.identity}:${stable}`;
        const row = rows.get(key) ?? {
          ...identity,
          harness: c.harness,
          calls: 0,
          loads: 0,
          reads: 0,
          lastObservedAt: timestamp,
        };
        row[event.kind]++;
        if (timestamp > row.lastObservedAt) row.lastObservedAt = timestamp;
        rows.set(key, row);
      }
      const now = yield* DateTime.now;
      return {
        window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
        project,
        rows: [...rows.values()].sort(
          (a, b) =>
            b.calls + b.loads + b.reads - (a.calls + a.loads + a.reads) ||
            a.name.localeCompare(b.name) ||
            String(a.path).localeCompare(String(b.path)),
        ),
        coverage,
        incomplete: coverage.some(
          (c) =>
            c.status === "unreadable" ||
            c.malformed +
              c.undatedCandidates +
              c.unsupported +
              c.oversizedLines +
              c.skippedFiles +
              c.unreadableFiles +
              c.changedFiles +
              c.unknownProjectRecords >
              0,
        ),
        durationMs: Math.max(0, DateTime.toEpochMillis(now) - clockStart),
      } satisfies UsageReport;
    });
    return SkillUsage.of({ scan });
  }),
);
