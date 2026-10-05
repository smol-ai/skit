import { assert } from "@effect/vitest";
import { Schema, SchemaAST } from "effect";
import type { HttpClientRequest } from "effect/http";
import { LegacyLibraryManifestV2, type LibraryState } from "@smolai/skit-core";
import {
  InvalidRequestResponse,
  LibraryManifest,
  LibraryNotFoundResponse,
  LibraryReceipt,
  LibraryResponse,
  LibraryWriteRequest,
  RevisionConflictResponse,
  SnapshotArchive,
  SnapshotUploadResponse,
  StorageFailureResponse,
} from "@smolai/skit-core/universal/api";

/** Every one-shot failure a sync test can inject, each consumed at the boundary it targets. */
export type Fault =
  | { readonly _tag: "FailUpload" }
  | { readonly _tag: "RejectWrite" }
  /** Another home commits this manifest just before the next write is evaluated. */
  | { readonly _tag: "CompetingWrite"; readonly manifest: LibraryManifest }
  /** The next write commits, then the Registry answers 500. */
  | { readonly _tag: "ErrorAfterCommit" }
  /** The next write commits, then the connection drops before any response. */
  | { readonly _tag: "DropAfterCommit" }
  /** The next local state publication fails; `anchoredOnly` waits for one anchored to the head. */
  | { readonly _tag: "FailPublish"; readonly anchoredOnly: boolean }
  /** Another writer replaces `home`'s state when sync reads the remote head. */
  | {
      readonly _tag: "ChangeStateWhenHeadRead";
      readonly home: string;
      readonly state: LibraryState;
    }
  /** A file occupies `path` right after `home` publishes, so projection there fails. */
  | { readonly _tag: "ObstructAfterPublish"; readonly home: string; readonly path: string };

/** Pending faults in injection order; each dispatch point takes the first one that applies. */
export const faultQueue = () => {
  const pending: Fault[] = [];
  return {
    inject: (fault: Fault) => {
      pending.push(fault);
    },
    take: <T extends Fault["_tag"]>(
      tag: T,
      applies: (fault: Extract<Fault, { readonly _tag: T }>) => boolean = () => true,
    ) => {
      const fault = pending
        .filter((item): item is Extract<Fault, { readonly _tag: T }> => item._tag === tag)
        .find(applies);
      if (fault !== undefined) pending.splice(pending.indexOf(fault), 1);
      return fault;
    },
    /** Faults injected but never reached; a test that leaves one proved nothing about it. */
    unconsumed: () => [...pending],
  };
};

/** Encode a body with its contract schema and answer with the status that schema declares. */
const reply = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Response.json(Schema.encodeSync(schema)(value), {
    status: SchemaAST.resolveAt<number>("httpApiStatus")(schema.ast) ?? 200,
  });

/**
 * An in-memory Registry speaking the core Library sync contract. Responses are encoded with the
 * contract schemas the Worker uses; the Worker suite proves the same compare-and-swap rules on
 * real D1.
 */
export function librarySyncServer(faults = faultQueue()) {
  let head: LibraryReceipt | null = null;
  let legacyHead: LegacyLibraryManifestV2 | undefined;
  const snapshots = new Map<string, SnapshotArchive>();
  const revisions: { revision_id: string; parent_revision_id: string | null }[] = [];
  let libraryId = "library_test";

  const write = (request: typeof LibraryWriteRequest.Type): Response => {
    if (request.expected_revision_id !== (head?.revision_id ?? null))
      return reply(RevisionConflictResponse, { error: "REVISION_CONFLICT" });
    // The Worker treats a write whose manifest JSON matches the current head as already applied.
    if (head !== null && JSON.stringify(head.manifest) === JSON.stringify(request.manifest))
      return reply(LibraryResponse, { library: head });
    if (request.manifest.snapshot_digests.some((digest) => !snapshots.has(digest)))
      return reply(InvalidRequestResponse, { error: "invalid_request" });
    revisions.push({
      revision_id: `revision_${revisions.length + 1}`,
      parent_revision_id: head?.revision_id ?? null,
    });
    head = {
      library_id: libraryId,
      revision_id: revisions.at(-1)!.revision_id,
      manifest: request.manifest,
    };
    return reply(LibraryResponse, { library: head });
  };

  const respond = (method: string, path: string, payload?: unknown): Response => {
    if (method === "GET" && path.startsWith("/api/libraries/")) {
      const archive = snapshots.get(decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)));
      return archive === undefined
        ? reply(LibraryNotFoundResponse, { error: "library_not_found" })
        : reply(SnapshotArchive, archive);
    }
    if (method === "GET" && path === "/api/library/portable") {
      if (head === null) return reply(LibraryNotFoundResponse, { error: "library_not_found" });
      if (legacyHead === undefined) return reply(LibraryResponse, { library: head });
      return Response.json({
        library: { ...head, manifest: Schema.encodeSync(LegacyLibraryManifestV2)(legacyHead) },
      });
    }
    if (method === "POST" && path === "/api/library/snapshots") {
      if (faults.take("FailUpload"))
        return reply(StorageFailureResponse, { error: "storage_failure" });
      const archive = Schema.decodeUnknownSync(SnapshotArchive)(payload);
      const reused = snapshots.has(archive.digest);
      snapshots.set(archive.digest, archive);
      return reply(SnapshotUploadResponse, {
        library_id: libraryId,
        snapshot_digest: archive.digest,
        reused,
      });
    }
    if (method === "PUT" && path === "/api/library/portable") {
      const competing = faults.take("CompetingWrite");
      if (competing)
        assert.strictEqual(
          write({ expected_revision_id: head?.revision_id ?? null, manifest: competing.manifest })
            .status,
          200,
        );
      const request = Schema.decodeUnknownSync(LibraryWriteRequest)(payload);
      if (faults.take("RejectWrite"))
        return reply(RevisionConflictResponse, { error: "REVISION_CONFLICT" });
      const response = write(request);
      if (response.status !== 200) return response;
      if (faults.take("ErrorAfterCommit"))
        return reply(StorageFailureResponse, { error: "storage_failure" });
      if (faults.take("DropAfterCommit"))
        throw new TypeError("Connection reset after committed Library write");
      return response;
    }
    return assert.fail(`Unexpected request: ${method} ${path}`);
  };

  return {
    respond,
    /** Answer a client request as the Registry's HTTP boundary would. */
    transport: (incoming: HttpClientRequest.HttpClientRequest) =>
      respond(
        incoming.method,
        new URL(incoming.url).pathname,
        incoming.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(incoming.body.body))
          : undefined,
      ),
    /** A pre-portable client replaces the head through the legacy v2 endpoint. */
    replaceHeadWithLegacy: (manifest: LegacyLibraryManifestV2) => {
      legacyHead = manifest;
    },
    get remote() {
      return head;
    },
    get writes() {
      return revisions.length;
    },
    get stored() {
      return { head, revisions: [...revisions], snapshots: [...snapshots.entries()] };
    },
    reset() {
      head = null;
      legacyHead = undefined;
      snapshots.clear();
      revisions.length = 0;
      libraryId = "library_recreated";
    },
  };
}
