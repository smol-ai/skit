import { Effect, Schema } from "effect";
import { D1Client } from "@effect/sql-d1";
import { unzipSync } from "fflate";
import { databaseError } from "../platform/cloudflare.js";
import { Digest, IntegrityError } from "../integrity/contracts.js";
import { sha256 } from "../integrity/crypto.js";
import { validateArtifactBundle } from "../integrity/validate.js";

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RELEASE_ARCHIVE_BYTES = 25 * 1024 * 1024;

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
  const entries = view.getUint16(end + 10, true);
  const centralBytes = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  const commentBytes = view.getUint16(end + 20, true);
  if (
    entries === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff ||
    end + 22 + commentBytes !== archive.byteLength ||
    entries < 1 ||
    entries > MAX_FILES ||
    centralOffset + centralBytes > end
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
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      uncompressed > MAX_FILE_BYTES ||
      next > end
    )
      throw invalidArchive();
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameBytes));
    if (!safeArchivePath(name) || seen.has(name)) throw invalidArchive();
    total += uncompressed;
    if (total > MAX_RELEASE_ARCHIVE_BYTES) throw invalidArchive();
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
  const files = yield* Effect.try({
    try: () => unzipSync(archive),
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

export const verifyReleaseSnapshot = Effect.fn("Integrity.verifyReleaseSnapshot")(function* (
  expected: ReadonlyMap<string, Uint8Array>,
  archive: Uint8Array,
) {
  const { names, files } = yield* readArchive(archive);
  if (expected.size !== names.length || names.some((name) => !expected.has(name)))
    return yield* manifestMismatch();
  for (const [path, stored] of expected) {
    const candidate = files[path];
    if (
      !candidate ||
      candidate.byteLength !== stored.byteLength ||
      candidate.some((byte, index) => byte !== stored[index])
    )
      return yield* manifestMismatch();
  }
});

const DraftFileRow = Schema.Struct({
  path: Schema.String,
  blob_digest: Digest,
  byte_length: Schema.Int,
  media_type: Schema.String,
  executable: Schema.Int,
});

const DraftRevisionRow = Schema.Struct({
  owner_slug: Schema.String,
  skit_slug: Schema.String,
  descriptor_json: Schema.String,
});

const JsonDocument = Schema.fromJsonString(Schema.Unknown);

export const verifyReleaseArchive = Effect.fn("Integrity.verifyReleaseArchive")(function* (
  revisionId: string,
  archive: Uint8Array,
) {
  const { names, files } = yield* readArchive(archive);
  const sql = yield* D1Client.D1Client;
  const unknownRows = yield* sql`SELECT path, blob_digest, byte_length, media_type, executable
    FROM draft_files WHERE revision_id = ${revisionId} ORDER BY path`.pipe(
    databaseError("read release archive manifest"),
  );
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(DraftFileRow))(unknownRows).pipe(
    Effect.mapError(
      (error) => new IntegrityError({ code: "ARCHIVE_MANIFEST_MISMATCH", detail: error.message }),
    ),
  );
  if (rows.length !== names.length || rows.some(({ path }, index) => path !== names[index]))
    return yield* manifestMismatch();
  for (const row of rows) {
    const bytes = files[row.path];
    if (
      !bytes ||
      bytes.byteLength !== row.byte_length ||
      (yield* sha256(bytes)) !== row.blob_digest
    )
      return yield* manifestMismatch();
  }
  const revisionRows = yield* sql`SELECT owner_slug, skit_slug, descriptor_json
    FROM draft_revisions WHERE revision_id = ${revisionId}`.pipe(
    databaseError("read release archive revision"),
  );
  if (revisionRows[0] === undefined)
    return yield* new IntegrityError({ code: "DRAFT_REVISION_MISSING" });
  const revision = yield* Schema.decodeUnknownEffect(DraftRevisionRow)(revisionRows[0]).pipe(
    Effect.mapError(
      (error) => new IntegrityError({ code: "DRAFT_REVISION_MISSING", detail: error.message }),
    ),
  );
  const descriptor = yield* Schema.decodeUnknownEffect(JsonDocument)(revision.descriptor_json).pipe(
    Effect.mapError(
      (error) => new IntegrityError({ code: "INVALID_DESCRIPTOR", detail: error.message }),
    ),
  );
  return (yield* validateArtifactBundle(
    revision.owner_slug,
    revision.skit_slug,
    descriptor,
    rows.map((row) => ({
      path: row.path,
      bytes: files[row.path],
      digest: row.blob_digest,
      media_type: row.media_type,
      executable: Boolean(row.executable),
    })),
  )).diagnostics;
});
