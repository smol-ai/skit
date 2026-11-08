/** Read-only marker parsing and inspection, independent of installed-file mutations. */
import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join } from "node:path";
import { OwnershipMarker } from "./ownership-marker.js";
import { StoredOwnershipMarker } from "./ownership-marker-compat.js";

const OwnershipMarkerDocument = Schema.fromJsonString(Schema.Unknown);

export function readOwnershipMarker(
  path: string,
): Effect.Effect<OwnershipMarker | null, PlatformError, FileSystem.FileSystem> {
  return inspectOwnershipMarker(path).pipe(
    Effect.map((inspected) => (inspected.kind === "valid" ? inspected.marker : null)),
  );
}

export const OwnershipMarkerInspection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({ kind: Schema.Literal("invalid"), detail: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("valid"), marker: OwnershipMarker }),
]);
export type OwnershipMarkerInspection = typeof OwnershipMarkerInspection.Type;

export function parseOwnershipMarker(value: unknown): OwnershipMarkerInspection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "invalid", detail: "Ownership marker must be a JSON object" };
  const decoded = Schema.decodeUnknownOption(StoredOwnershipMarker)(value);
  if (decoded._tag === "Some") return { kind: "valid", marker: decoded.value };
  return { kind: "invalid", detail: "Ownership marker has invalid typed fields" };
}

export function inspectOwnershipMarker(
  path: string,
): Effect.Effect<OwnershipMarkerInspection, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // A missing marker is absent; unreadable is a real failure; unparseable is invalid.
    const text = yield* fs
      .readFileString(join(path, ".skit-ownership.json"))
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
    if (text === undefined) return { kind: "absent" as const };
    const parsed = Schema.decodeOption(OwnershipMarkerDocument)(text);
    return parsed._tag === "Some"
      ? parseOwnershipMarker(parsed.value)
      : ({ kind: "invalid", detail: "Ownership marker is invalid JSON" } as const);
  });
}
