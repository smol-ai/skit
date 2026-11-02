import { Effect, Schema } from "effect";
import { D1Client } from "@effect/sql-d1";
import { unzipSync } from "fflate";
import { databaseError } from "../platform/cloudflare.js";
import {
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_ARTIFACT_FILES,
} from "@smolai/skit-core/universal/authoring";
import { Hash, sha256Hash } from "@smolai/skit-core/universal/consumer";
import { IntegrityError } from "../integrity/contracts.js";
import { unpublishableEntries, validateArtifactBundle } from "../integrity/validate.js";

const invalidArchive = () => new IntegrityError({ code: "INVALID_ARCHIVE" });
const manifestMismatch = () => new IntegrityError({ code: "ARCHIVE_MANIFEST_MISMATCH" });

const safeArchivePath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.endsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !path.split("/").includes("..") &&
  !/^[A-Za-z]:/.test(path) &&
  path.normalize("NFC") === path;

const archiveEntryNamesUnsafe = (archive: Uint8Array): Array<string> => {
  if (archive.byteLength < 22) throw invalidArchive();
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (
    let offset = archive.byteLength - 22;
    offset >= Math.max(0, archive.byteLength - 65_557);
    offset--
  )
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  if (end < 0) throw invalidArchive();
  // Inflaters disagree on which end-record count to trust, so both counts, the single disk, and a
  // directory ending exactly at the end record must agree before any of it is believed. SKIT's
  // archive writer adds ZIP64 records there only past limits this preflight already rejects.
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const entriesOnDisk = view.getUint16(end + 8, true);
  const entries = view.getUint16(end + 10, true);
  const centralBytes = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  const commentBytes = view.getUint16(end + 20, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff ||
    end + 22 + commentBytes !== archive.byteLength ||
    entries < 1 ||
    entries > MAX_ARTIFACT_FILES ||
    centralOffset + centralBytes !== end
  )
    throw invalidArchive();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names: Array<string> = [];
  const seen = new Set<string>();
  let total = 0;
  let offset = centralOffset;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalidArchive();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const entryCommentBytes = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      // A stored entry is copied at its compressed size, so that must be the size budgeted here.
      (method === 0 && compressed !== uncompressed) ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      next > end
    )
      throw invalidArchive();
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameBytes));
    if (!safeArchivePath(name) || seen.has(name)) throw invalidArchive();
    total += uncompressed;
    if (total > MAX_ARTIFACT_CONTENT_BYTES) throw invalidArchive();
    seen.add(name);
    names.push(name);
    offset = next;
  }
  if (offset !== centralOffset + centralBytes) throw invalidArchive();
  return names.sort();
};

export const readArchive = Effect.fn("Integrity.readArchive")(function* (archive: Uint8Array) {
  const names = yield* Effect.try({
    try: () => archiveEntryNamesUnsafe(archive),
    catch: () => invalidArchive(),
  });
  // Inflate only what the preflight validated, each name once, within the content budget.
  const unread = new Set(names);
  let budget = MAX_ARTIFACT_CONTENT_BYTES;
  const files = yield* Effect.try({
    try: () =>
      unzipSync(archive, {
        filter: ({ name, originalSize }) => {
          budget -= originalSize;
          if (!unread.delete(name) || budget < 0) throw invalidArchive();
          return true;
        },
      }),
    catch: () => invalidArchive(),
  });
  if (
    Object.keys(files)
      .sort()
      .some((name, index) => name !== names[index])
  )
    return yield* invalidArchive();
  return { names, files };
});

const TreeEntryRow = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink"]),
  mode: Schema.NullOr(Schema.Int),
  blob_hash: Schema.NullOr(Hash),
  byte_length: Schema.NullOr(Schema.Int),
});

const RevisionRow = Schema.Struct({ tree_hash: Schema.String, descriptor_json: Schema.String });

const JsonDocument = Schema.fromJsonString(Schema.Unknown);

/**
 * Check an uploaded archive against one revision of a SKIT and validate it for publication. A
 * tree with entries a Release cannot hold is refused with their diagnostics; otherwise the archive
 * must hold exactly the tree's files, each with the same length and hash.
 */
export const verifyReleaseArchive = Effect.fn("Integrity.verifyReleaseArchive")(function* (
  owner: string,
  slug: string,
  revisionId: string,
  archive: Uint8Array,
) {
  const { names, files } = yield* readArchive(archive);
  const sql = yield* D1Client.D1Client;
  const revisionRows = yield* sql`SELECT tree_hash, descriptor_json FROM revisions
    WHERE owner_slug = ${owner} AND skit_slug = ${slug} AND revision_id = ${revisionId}`.pipe(
    databaseError("read release archive revision"),
  );
  if (revisionRows[0] === undefined) return yield* new IntegrityError({ code: "REVISION_MISSING" });
  const revision = yield* Schema.decodeUnknownEffect(RevisionRow)(revisionRows[0]).pipe(
    Effect.mapError(
      (error) => new IntegrityError({ code: "REVISION_MISSING", detail: error.message }),
    ),
  );
  const unknownRows = yield* sql`SELECT path, kind, mode, blob_hash, byte_length
    FROM revision_tree_entries WHERE tree_hash = ${revision.tree_hash}`.pipe(
    databaseError("read release archive manifest"),
  );
  const entries = yield* Schema.decodeUnknownEffect(Schema.Array(TreeEntryRow))(unknownRows).pipe(
    Effect.mapError(
      (error) => new IntegrityError({ code: "ARCHIVE_MANIFEST_MISMATCH", detail: error.message }),
    ),
  );
  const unpublishable = unpublishableEntries(entries);
  if (unpublishable.length > 0) return unpublishable;
  const rows = entries.filter(({ kind }) => kind === "file");
  // Archive names are unique, so equal counts and every path present means the same set.
  if (rows.length !== names.length || rows.some(({ path }) => files[path] === undefined))
    return yield* manifestMismatch();
  const verified = [];
  for (const row of rows) {
    const bytes = files[row.path];
    if (
      !bytes ||
      bytes.byteLength !== row.byte_length ||
      row.blob_hash === null ||
      (yield* sha256Hash(bytes)) !== row.blob_hash
    )
      return yield* manifestMismatch();
    verified.push({
      path: row.path,
      bytes,
      digest: row.blob_hash,
      executable: row.mode === 0o755,
    });
  }
  const descriptor = yield* Schema.decodeUnknownEffect(JsonDocument)(revision.descriptor_json).pipe(
    Effect.mapError(
      (error) => new IntegrityError({ code: "INVALID_DESCRIPTOR", detail: error.message }),
    ),
  );
  return (yield* validateArtifactBundle(owner, slug, descriptor, verified)).diagnostics;
});
