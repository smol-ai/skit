import { assert } from "@effect/vitest";
import { Schema } from "effect";
import { LibraryManifest, LibraryWriteRequest, SnapshotArchive } from "@smolai/skit-core";
import type { TestHttpHandler } from "./http-test-client.js";

/** An external HTTP fake, characterized against the real Worker by the shared CAS table. */
export function librarySyncServer() {
  let published: { library_id: string; revision_id: string; manifest: LibraryManifest } | null =
    null;
  const snapshots = new Map<string, typeof SnapshotArchive.Type>();
  const revisions: {
    revision_id: string;
    parent_revision_id: string | null;
    manifest: LibraryManifest;
  }[] = [];
  let libraryId = "library_test";
  const faults = {
    loseNextWriteResponse: false,
    rejectNextWrite: false,
    competingWrite: undefined as LibraryManifest | undefined,
    remoteManifest: undefined as unknown,
    failNextUpload: false,
  };
  const respond = (method: string, path: string, payload?: unknown): Response => {
    if (path.startsWith("/api/libraries/")) {
      const archive = snapshots.get(decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)));
      return archive === undefined
        ? Response.json({ error: "library_not_found" }, { status: 404 })
        : Response.json(archive);
    }
    if (path === "/api/library/portable" && method === "GET")
      return published === null
        ? Response.json({ error: "library_not_found" }, { status: 404 })
        : Response.json({
            library: { ...published, manifest: faults.remoteManifest ?? published.manifest },
          });
    if (path === "/api/library/snapshots" && method === "POST") {
      if (faults.failNextUpload) {
        faults.failNextUpload = false;
        return Response.json({ error: "storage_failure" }, { status: 500 });
      }
      const archive = Schema.decodeUnknownSync(SnapshotArchive)(payload);
      const reused = snapshots.has(archive.digest);
      snapshots.set(archive.digest, archive);
      return Response.json({ library_id: libraryId, snapshot_digest: archive.digest, reused });
    }
    if (path === "/api/library/portable" && method === "PUT") {
      if (faults.competingWrite !== undefined) {
        const manifest = faults.competingWrite;
        faults.competingWrite = undefined;
        assert.strictEqual(
          respond("PUT", path, { expected_revision_id: published?.revision_id ?? null, manifest })
            .status,
          200,
        );
      }
      const request = Schema.decodeUnknownSync(LibraryWriteRequest)(payload);
      if (faults.rejectNextWrite) {
        faults.rejectNextWrite = false;
        return Response.json({ error: "REVISION_CONFLICT" }, { status: 409 });
      }
      if (request.expected_revision_id !== (published?.revision_id ?? null))
        return Response.json({ error: "REVISION_CONFLICT" }, { status: 409 });
      if (
        published !== null &&
        JSON.stringify(published.manifest) === JSON.stringify(request.manifest)
      )
        return Response.json({ library: published });
      for (const digest of request.manifest.snapshot_digests)
        if (!snapshots.has(digest))
          return Response.json({ error: "invalid_request" }, { status: 400 });
      const parent_revision_id = published?.revision_id ?? null;
      published = {
        library_id: libraryId,
        revision_id: `revision_${revisions.length + 1}`,
        manifest: request.manifest,
      };
      revisions.push({
        revision_id: published.revision_id,
        parent_revision_id,
        manifest: request.manifest,
      });
      if (faults.loseNextWriteResponse) {
        faults.loseNextWriteResponse = false;
        return Response.json({ error: "storage_failure" }, { status: 500 });
      }
      return Response.json({ library: published });
    }
    assert.fail(`Unexpected request: ${method} ${path}`);
  };
  const transport: TestHttpHandler = (incoming) => {
    const payload: unknown =
      incoming.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(incoming.body.body))
        : undefined;
    return respond(incoming.method, new URL(incoming.url).pathname, payload);
  };
  return {
    transport,
    respond,
    faults,
    get remote() {
      return published;
    },
    get writes() {
      return revisions.length;
    },
    get stored() {
      return { head: published, revisions: [...revisions], snapshots: [...snapshots.entries()] };
    },
    reset() {
      published = null;
      snapshots.clear();
      revisions.length = 0;
      libraryId = "library_recreated";
    },
  };
}
