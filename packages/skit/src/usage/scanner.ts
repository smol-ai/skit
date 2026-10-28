import { NodeStream } from "@effect/platform-node";
import { systemError } from "effect/PlatformError";
import { createZstdDecompress } from "node:zlib";
import { Clock, Context, DateTime, Effect, FileSystem, Layer, Option, Stream } from "effect";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { harnessDrivers } from "../harnesses/drivers.js";
import { LinkStat } from "../platform/link-stat.js";
import { correlateInvocations, type Invocation } from "./invocations.js";
import { extractUsage, object, type UsageEvent } from "./events.js";
import {
  InvalidUsageOptions,
  type UsageCoverage,
  type UsageOptions,
  type InstalledSkillUsage,
  type UsageReport,
  type UsageRow,
} from "./contracts.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Coverage = Mutable<UsageCoverage>;
interface SourceFile {
  path: string;
  size: number;
  modified: number;
  coverage: Coverage;
}
interface TranscriptEvent {
  event: UsageEvent;
  timestamp: string;
  cwd?: string;
  coverage: Coverage;
  session: string;
  sessionKnown: boolean;
  turn?: string;
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
      const durationStart = yield* Clock.monotonicTimeNanos;
      const began = yield* DateTime.now;
      const clockStart = DateTime.toEpochMillis(began);
      const end = options.end === undefined ? clockStart : Date.parse(options.end);
      const days = options.days ?? 7;
      if (!Number.isFinite(end) || !Number.isInteger(days) || days < 1 || days > 3650)
        return yield* new InvalidUsageOptions({
          message: "Use a valid end timestamp and a whole number of days between 1 and 3650.",
        });
      const start = end - days * 86400000;
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()))
        return yield* new InvalidUsageOptions({
          message: "Both window boundaries must be within the supported date range.",
        });
      const window = { start: startDate.toISOString(), end: endDate.toISOString() };
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
          if (dir.endsWith(".jsonl") || dir.endsWith(".jsonl.zst")) {
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
          }
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
      const observations: TranscriptEvent[] = [];
      let completed = 0;
      for (const file of files) {
        const c = file.coverage;
        let cwd: string | undefined;
        let session = file.path;
        let agent = /\/subagents\/agent-([^/]+)\.jsonl(?:\.zst)?$/.exec(file.path)?.[1];
        let sessionKnown = false;
        let turn: string | undefined;
        let observedBytes = 0;
        const projectCwds = new Map<string, string>();
        const consume = Effect.fn("SkillUsage.record")(function* (line: string) {
          if (!line.length) return;
          let raw: unknown;
          try {
            raw = JSON.parse(line);
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
          if (c.harness === "codex") {
            if (r.type === "session_meta" && typeof p.id === "string") {
              if (session !== p.id) turn = undefined;
              session = p.id;
              sessionKnown = true;
            }
            if (
              (r.type === "turn_context" ||
                (r.type === "event_msg" && p.type === "task_started")) &&
              typeof p.turn_id === "string"
            )
              turn = p.turn_id;
          } else {
            if (typeof r.agentId === "string") agent = r.agentId;
            if (typeof r.sessionId === "string") {
              const conversation = JSON.stringify([r.sessionId, agent ?? null]);
              if (session !== conversation) turn = undefined;
              session = conversation;
              sessionKnown = true;
            }
            const message = object(r.message);
            const content = message.content;
            const userText =
              typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content
                      .map((b) => object(b).text)
                      .filter((t): t is string => typeof t === "string")
                      .join("\n")
                  : "";
            const userInput =
              typeof content === "string"
                ? content.length > 0
                : Array.isArray(content) && content.some((b) => object(b).type !== "tool_result");
            // Tool results and instruction expansions do not start a user turn.
            if (
              r.type === "user" &&
              r.isMeta !== true &&
              r.isCompactSummary !== true &&
              userInput &&
              !userText.startsWith("Base directory for this skill:")
            )
              turn =
                typeof r.promptId === "string"
                  ? r.promptId
                  : typeof r.uuid === "string"
                    ? r.uuid
                    : undefined;
          }
          if (
            r.type === "compacted" ||
            r.isCompactSummary === true ||
            (r.type === "system" && r.subtype === "compact_boundary")
          )
            turn = undefined;
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
            c.undatedCandidates += extractUsage(
              harnessDrivers[c.harness].transcripts.grammar,
              r,
            ).events.length;
            return;
          }
          if (stamp < start || stamp >= end) return;
          let recordCwd = cwd;
          if (project !== null) {
            if (!recordCwd) {
              c.unknownProjectRecords++;
              return;
            }
            let canonical = projectCwds.get(recordCwd);
            if (!canonical) {
              canonical = yield* physical(recordCwd);
              projectCwds.set(recordCwd, canonical);
            }
            if (canonical !== project) return;
            recordCwd = canonical;
          }
          c.windowRecords++;
          const extracted = extractUsage(harnessDrivers[c.harness].transcripts.grammar, r);
          c.unsupported += extracted.unsupported;
          c.summaries += extracted.summaries;
          c.mentions += extracted.mentions;
          c.slashCommands += extracted.slashCommands;
          for (const event of extracted.events)
            observations.push({
              event,
              timestamp: new Date(stamp).toISOString(),
              cwd: recordCwd,
              coverage: c,
              session,
              sessionKnown,
              turn,
            });
        });
        const bytes = fs.stream(file.path, { chunkSize: 256 * 1024, bytesToRead: file.size }).pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              observedBytes += chunk.length;
              c.bytesRead += chunk.length;
            }),
          ),
        );
        const contents = file.path.endsWith(".zst")
          ? bytes.pipe(
              NodeStream.pipeThroughDuplex({
                evaluate: () => createZstdDecompress(),
                onError: (cause) =>
                  systemError({
                    _tag: "InvalidData",
                    module: "FileSystem",
                    method: "zstdDecompress",
                    pathOrDescriptor: file.path,
                    cause,
                  }),
              }),
            )
          : bytes;
        yield* contents.pipe(
          // Recover only file reads and decompression; parsing owns its failures.
          Stream.catchTag("PlatformError", () => {
            c.unreadableFiles++;
            return Stream.empty;
          }),
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach(consume),
        );
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
      const installedSkills = new Map<string, InstalledSkillUsage[]>();
      for (const installedSkill of options.installedSkills ?? []) {
        const document = installedSkill.path.endsWith("/SKILL.md")
          ? installedSkill.path
          : join(installedSkill.path, "SKILL.md");
        for (const key of new Set([resolve(document), yield* physical(resolve(document))])) {
          const values = installedSkills.get(key) ?? [];
          if (!values.some((v) => v.skillId === installedSkill.skillId))
            values.push(installedSkill);
          installedSkills.set(key, values);
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
      const invocationObservations: Invocation[] = [];
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
            ? (installedSkills.get(canonical) ?? installedSkills.get(lexical ?? "") ?? [])
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
        const replay = fingerprint(
          `${c.harness}:${observation.sessionKnown ? observation.session : ""}:${event.kind}:${event.id ?? timestamp}:${stable}`,
        );
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
          uses: 0,
          explicit: 0,
          implicit: 0,
          unknown: 0,
          lastObservedAt: timestamp,
        };
        if (event.kind !== "selections") row[event.kind]++;
        invocationObservations.push({
          key,
          row,
          event,
          session: observation.session,
          turn: observation.turn,
          timestamp,
        });
        if (timestamp > row.lastObservedAt) row.lastObservedAt = timestamp;
        rows.set(key, row);
      }
      correlateInvocations(invocationObservations);
      const durationEnd = yield* Clock.monotonicTimeNanos;
      return {
        window,
        project,
        rows: [...rows.values()]
          .filter((row) => row.uses + row.calls + row.loads + row.reads > 0)
          .sort(
            (a, b) =>
              b.uses - a.uses ||
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
              c.skippedFiles +
              c.unreadableFiles +
              c.changedFiles +
              c.unknownProjectRecords >
              0,
        ),
        durationMs: Math.max(0, Number(durationEnd - durationStart) / 1_000_000),
      } satisfies UsageReport;
    });
    return SkillUsage.of({ scan });
  }),
);
