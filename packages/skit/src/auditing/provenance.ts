import { artifactUsesSymlink } from "../platform/path-identity.js";
import { inspectOwnershipMarker } from "../installed-skills/marker-inspection.js";
import { isJsonObject, stringAt, type JsonObject } from "../shared/json.js";
import { dirname, join, normalize, sep } from "node:path";
import { Effect } from "effect";
import { canonical } from "./io.js";
import { pnpmSkillOwner, type PnpmSkillCheck } from "../installed-skills/pnpm-skills.js";
import { AuditOrigin } from "./provenance-facts.js";

function codexSystemSkillsRoot(path: string): string | null {
  const parts = normalize(path).split(sep);
  const systemIndex = parts.findIndex(
    (part, index) =>
      part === ".system" && parts[index - 1] === "skills" && parts[index - 2] === ".codex",
  );
  return systemIndex < 0 ? null : parts.slice(0, systemIndex + 1).join(sep) || sep;
}

export const fileProvenance = Effect.fn("Audit.fileProvenance")(function* (
  path: string,
  lock: JsonObject,
  name: string,
  occurrences = 1,
  checkPnpm: PnpmSkillCheck = pnpmSkillOwner,
) {
  const pnpm = yield* checkPnpm(dirname(path));
  if (pnpm)
    return {
      confidence: "exact" as const,
      origin: AuditOrigin.cases.PnpmPackage.make({ package: pnpm.package, version: pnpm.version }),
      evidence: pnpm.ledgerPath,
    };
  const markerPath = join(dirname(path), ".skit-ownership.json");
  const markerInspection = yield* inspectOwnershipMarker(dirname(path)).pipe(
    Effect.orElseSucceed(() => ({ kind: "absent" }) as const),
  );
  if (markerInspection.kind === "valid") {
    const marker = markerInspection.marker;
    const claim = {
      skillId: marker.skill_id,
      expectedHash: marker.expected_hash,
    };
    return {
      confidence: "exact" as const,
      origin: AuditOrigin.cases.SkitManaged.make({}),
      evidence: markerPath,
      ...claim,
    };
  }
  const systemSkillsRoot = codexSystemSkillsRoot(path);
  if (systemSkillsRoot)
    return {
      confidence: "exact" as const,
      origin: AuditOrigin.cases.BundledSkills.make({ harness: "codex" }),
      evidence: systemSkillsRoot,
    };
  const locked = lock[name];
  if (locked)
    return {
      confidence: occurrences > 1 ? ("matched" as const) : ("exact" as const),
      origin: AuditOrigin.cases.SkillsSh.make({}),
      evidence: isJsonObject(locked)
        ? (stringAt(locked, "sourceUrl") ?? stringAt(locked, "source") ?? path)
        : path,
    };
  if (yield* artifactUsesSymlink(path))
    return {
      confidence: "exact" as const,
      origin: AuditOrigin.cases.Symlink.make({}),
      evidence: yield* canonical(path),
    };
  return {
    confidence: "unknown" as const,
    origin: AuditOrigin.cases.Unknown.make({}),
    evidence: path,
  };
});
