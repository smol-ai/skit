import { Clock, Effect, FileSystem } from "effect";

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  isJsonObject,
  objectAt,
  observationPathIdentityEffect,
  parseOwnershipMarker,
} from "@smolai/skit-core";
import { auditClaude } from "./claude.js";
import { auditCodex } from "./codex.js";
import { pathExists, read, readJson as json } from "./io.js";
import { runAuditProbesEffect, type ProbeResult } from "./probes.js";
import { auditSkills } from "./skills.js";
import { retainedLibraryReferences } from "./library-ledger.js";
import type { AuditFinding, AuditObservation } from "./types.js";
import { deferredAuditHarnesses } from "../harness/catalog.js";
import { normalizeAuditReport } from "./normalize.js";

export interface AuditOptions {
  home?: string;
  cwd?: string;
  probes?: readonly string[];
  allowedSubprocesses?: readonly string[];
  stateHome?: string;
}

type LedgerInspection =
  | { kind: "absent" }
  | { kind: "unreadable"; path: string }
  | { kind: "readable"; retained: Set<string>; schemaVersion: unknown };

const inspectLibraryLedger = Effect.fn("Audit.ledger")(function* (
  home: string,
): Effect.gen.Return<LedgerInspection, never, FileSystem.FileSystem> {
  const path = join(home, ".skit", "state.json");
  const source = yield* read(path);
  if (source === null) return { kind: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { kind: "unreadable", path };
  }
  const retained = retainedLibraryReferences(value);
  if (retained === undefined || !isJsonObject(value)) return { kind: "unreadable", path };
  return {
    kind: "readable" as const,
    schemaVersion: value.schemaVersion,
    retained,
  };
});

const auditProjectionCustody = Effect.fn("Audit.custody")(function* (
  home: string,
  observations: readonly AuditObservation[],
) {
  const ledger = yield* inspectLibraryLedger(home);
  const inspected = new Set<string>();
  const findings: AuditFinding[] =
    ledger.kind === "unreadable"
      ? [
          {
            severity: "error",
            code: "unreadable-library-ledger",
            subject: ledger.path,
            problem: "SKIT Library state could not be read",
            locations: [ledger.path],
            details: { statePath: ledger.path },
          },
        ]
      : [];
  if (ledger.kind === "readable" && ledger.schemaVersion === 1)
    findings.push({
      severity: "error",
      code: "migration-required",
      subject: join(home, ".skit", "state.json"),
      problem: "SKIT Library state requires migration",
      locations: [join(home, ".skit", "state.json")],
      details: { code: "MIGRATION_REQUIRED", fromVersion: 1, toVersion: 2 },
    });
  for (const observation of observations) {
    if (observation.kind !== "skill" || !observation.path) continue;
    const directory = dirname(observation.path);
    const identity = yield* observationPathIdentityEffect(directory);
    if (inspected.has(identity.comparisonKey)) continue;
    inspected.add(identity.comparisonKey);
    const markerPath = join(directory, ".skit-ownership.json");
    const source = yield* read(markerPath);
    if (source === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      value = undefined;
    }
    const inspection = parseOwnershipMarker(value);
    if (inspection.kind === "invalid") {
      findings.push({
        severity: "error",
        code: "invalid-ownership-marker",
        subject: observation.path,
        problem: "SKIT ownership marker is invalid",
        locations: [markerPath],
        details: { markerPath, detail: inspection.detail },
      });
      continue;
    }
    if (inspection.kind === "valid" && ledger.kind !== "unreadable") {
      const claim = {
        collectionRef: `skill:${inspection.marker.skill_id}`,
        skillRef: inspection.marker.skill_id,
        expectedHash: inspection.marker.expected_digest,
        transactionId: undefined,
      };
      // A marker claim without a retained ledger entry is custody evidence, not proof that the
      // collection still exists. Keep it out of the TUI's retained-collection grouping.
      observation.provenance = {
        confidence: "matched",
        source: "SKIT orphan claim",
        evidence: markerPath,
        ...(observation.provenance.parentPlugin
          ? { parentPlugin: observation.provenance.parentPlugin }
          : {}),
        skillRef: claim.skillRef,
        expectedHash: claim.expectedHash,
        ...(claim.transactionId === undefined ? {} : { transactionId: claim.transactionId }),
      };
      findings.push({
        severity: "error",
        code: "orphaned-projection-claim",
        subject: observation.path,
        problem: "Projection claims SKIT ownership, but its Library entry is missing",
        locations: [observation.path, markerPath],
        details: {
          markerPath,
          collectionRef: claim.collectionRef,
          skillRef: claim.skillRef,
          destructiveAuthority: false,
        },
      });
    }
  }
  return findings;
});

/**
 * Observe local Harness capabilities.
 *
 * Every read and traversal goes through `audit/io.ts`, which is now Effects over the platform
 * services: the observation belongs to the caller's fiber rather than re-entering a runtime per
 * path. `suppliedProbes` carries subprocess results the caller already ran, so nothing spawns from
 * inside the observation.
 */
export const auditLocalCapabilitiesEffect = Effect.fn("Audit.capabilities")(function* (
  options: AuditOptions = {},
  suppliedProbes?: readonly ProbeResult[],
) {
  const home = resolve(options.home ?? homedir());
  const cwd = resolve(options.cwd ?? process.cwd());
  const observations: AuditObservation[] = [];
  const findings: AuditFinding[] = [];
  const stateHome = options.stateHome ?? process.env.XDG_STATE_HOME;
  let lockPath: string | undefined;
  for (const candidate of [
    stateHome ? join(stateHome, "skills", ".skill-lock.json") : null,
    join(home, ".agents", ".skill-lock.json"),
  ])
    if (candidate && (yield* pathExists(candidate))) {
      lockPath = candidate;
      break;
    }
  const lock = (lockPath ? objectAt((yield* json(lockPath)) ?? {}, "skills") : {}) ?? {};

  const claude = yield* auditClaude(home, cwd, lock);
  observations.push(...claude.observations);
  findings.push(...claude.findings);

  const skills = yield* auditSkills(home, cwd, lock, claude.skills);
  observations.push(...skills.observations);
  findings.push(...skills.findings);
  findings.push(...(yield* auditProjectionCustody(home, skills.observations)));

  const codex = yield* auditCodex(home, cwd);
  observations.push(...codex.observations);
  findings.push(...codex.findings);

  const configuredMcp = new Set(
    observations
      .filter((item) => item.kind === "mcp-server" && item.scope !== "legacy")
      .map((item) => item.name),
  );
  const unsupportedMcp = new Set(
    observations
      .filter((item) => item.kind === "mcp-server" && item.scope === "legacy")
      .map((item) => item.name),
  );
  for (const [server, paths] of claude.advertisedMcp)
    if (!configuredMcp.has(server) && !unsupportedMcp.has(server))
      findings.push({
        severity: "warning",
        code: "advertised-mcp-not-configured",
        subject: server,
        problem: `Rules reference MCP server “${server}”, but no supported registration was found`,
        locations: [...paths],
        details: { server, advertisingPaths: [...paths] },
      });

  const probes = suppliedProbes ? [...suppliedProbes] : [];

  observations.sort((left, right) =>
    `${left.kind}\0${left.harnesses.join(",")}\0${left.name}\0${left.path}`.localeCompare(
      `${right.kind}\0${right.harnesses.join(",")}\0${right.name}\0${right.path}`,
    ),
  );
  return {
    generatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    home,
    cwd,
    coverage: {
      supported: skills.profiles.map((profile) => ({
        id: profile.id,
        profileId: profile.profile.id,
        version: profile.profile.version,
        frontmatterContracts: profile.frontmatter.map((contract) => contract.id),
        skillMetadataContracts: (profile.skillMetadata ?? []).map((contract) => contract.id),
        documentation: profile.documentation,
      })),
      deferred: deferredAuditHarnesses,
    },
    observations,
    findings,
    probes,
    summary: {
      capabilities: new Set(
        observations.map((item) =>
          item.kind === "skill" && item.canonicalPath
            ? `${item.kind}\0${item.canonicalPath}`
            : `${item.kind}\0${item.harnesses.join(",")}\0${item.name}\0${item.path}`,
        ),
      ).size,
      findings: findings.length,
    },
  };
});

/**
 * The audit the CLI runs.
 *
 * Its declared subprocesses execute through the process service on this fiber — interrupting the
 * command kills them — and the synchronous observation then folds their results into the report.
 * The filesystem reads stay synchronous on purpose: `audit/io.ts` is the audit's one read
 * chokepoint and the same code serves the synchronous consumer above.
 */
export const auditLocalCapabilitiesV1Alpha3Effect = Effect.fn("Audit.local")(function* (
  options: AuditOptions = {},
) {
  const probes = yield* runAuditProbesEffect(options);
  return normalizeAuditReport(yield* auditLocalCapabilitiesEffect(options, probes));
});
