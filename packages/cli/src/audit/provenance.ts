import {
  artifactUsesSymlinkEffect,
  inspectOwnershipMarkerEffect,
  isJsonObject,
  stringAt,
  type JsonObject,
} from "@smolai/skit-core";
import { dirname, join, normalize, sep } from "node:path";
import { Effect } from "effect";
import { canonical } from "./io.js";
import { pnpmSkillOwner, type PnpmSkillObserver } from "../projection/pnpm-skills.js";

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
  observePnpm: PnpmSkillObserver = pnpmSkillOwner,
) {
  const pnpm = yield* observePnpm(dirname(path));
  if (pnpm)
    return {
      confidence: "exact" as const,
      source: `pnpm · ${pnpm.package}@${pnpm.version}`,
      evidence: pnpm.ledgerPath,
    };
  const markerPath = join(dirname(path), ".skit-ownership.json");
  const markerInspection = yield* inspectOwnershipMarkerEffect(dirname(path)).pipe(
    Effect.orElseSucceed(() => ({ kind: "absent" }) as const),
  );
  if (markerInspection.kind === "valid") {
    const marker = markerInspection.marker;
    const claim = {
      skillId: marker.skill_id,
      expectedHash: marker.expected_digest,
    };
    return {
      confidence: "exact" as const,
      source: "SKIT projection",
      evidence: markerPath,
      ...claim,
    };
  }
  const systemSkillsRoot = codexSystemSkillsRoot(path);
  if (systemSkillsRoot)
    return {
      confidence: "exact" as const,
      source: "Codex system skills",
      evidence: systemSkillsRoot,
    };
  const locked = lock[name];
  if (locked)
    return {
      confidence: occurrences > 1 ? ("matched" as const) : ("exact" as const),
      source: "Skills CLI / skills.sh",
      evidence: isJsonObject(locked)
        ? (stringAt(locked, "sourceUrl") ?? stringAt(locked, "source") ?? path)
        : path,
    };
  if (yield* artifactUsesSymlinkEffect(path))
    return { confidence: "exact" as const, source: "symlink", evidence: yield* canonical(path) };
  return { confidence: "unknown" as const, source: null, evidence: path };
});
