import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  Authentication,
  type AuthenticationService,
  type Principal,
} from "../auth/authentication.js";
import { Authorization, type AuthorizationService } from "../authorization/service.js";
import { ReleaseStore } from "./store.js";

const errorResponse = (error: string, status: number) =>
  HttpServerResponse.json({ error }, { status, headers: { "cache-control": "no-store" } }).pipe(
    Effect.orDie,
  );

interface DownloadAccess {
  readonly authentication: AuthenticationService;
  readonly authorization: AuthorizationService;
}

const authenticationFailure = Symbol("ReleaseHttp.authenticationFailure");

export const download = Effect.fn("ReleaseHttp.download")(function* (
  target: { readonly owner: string; readonly slug: string; readonly version: string },
  access?: DownloadAccess,
) {
  const store = yield* ReleaseStore;
  const authenticate = access
    ? HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap(HttpServerRequest.toWeb),
        Effect.flatMap(access.authentication.authenticate),
        Effect.tapError((error) =>
          Effect.logError("release download authentication failed", error),
        ),
        Effect.result,
      )
    : Effect.succeed(undefined);

  const lookup = Effect.gen(function* () {
    if (target.version !== "latest") {
      const release = yield* store.findExactDownload(target);
      if (release === null || release.visibility !== "private") return release;
      if (access === undefined) return null;
      const authenticated = yield* authenticate;
      if (authenticated === undefined || authenticated._tag === "Failure")
        return authenticated === undefined ? null : authenticationFailure;
      if (authenticated.success === undefined) return null;
      return (yield* access.authorization.canReadRelease(
        authenticated.success,
        release.release_id,
        target.owner,
        target.slug,
      ))
        ? release
        : null;
    }
    if (access === undefined) return yield* store.findAnonymousDownload(target);
    const candidates = yield* store.listLatestDownloads(target);
    const publicFallback = candidates.find((candidate) => candidate.visibility !== "private");
    if (candidates[0] === publicFallback) return publicFallback;
    const authenticated = yield* authenticate;
    if (authenticated === undefined || authenticated._tag === "Failure") {
      if (publicFallback !== undefined) return publicFallback;
      return authenticated === undefined ? null : authenticationFailure;
    }
    const principal: Principal | undefined = authenticated.success;
    if (principal === undefined) return publicFallback ?? null;
    const privateCandidates = candidates.filter((candidate) => candidate.visibility === "private");
    const readable = yield* access.authorization.readableReleaseIds(
      principal,
      privateCandidates.map(({ release_id }) => release_id),
      target.owner,
      target.slug,
    );
    for (const candidate of candidates) {
      if (candidate.visibility !== "private") return candidate;
      if (readable.has(candidate.release_id)) return candidate;
    }
    return null;
  });

  return yield* lookup.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logError("release lookup failed", error).pipe(
          Effect.andThen(errorResponse("storage_failure", 500)),
        ),
      onSuccess: (release) => {
        if (release === authenticationFailure) return errorResponse("storage_failure", 500);
        if (release === null) return errorResponse("release_not_found", 404);
        return store.readArchive(release.archive_object_key).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.logError("release archive read failed", error).pipe(
                Effect.andThen(errorResponse("storage_failure", 500)),
              ),
            onSuccess: (archive) =>
              archive === null
                ? errorResponse("archive_not_found", 404)
                : Effect.succeed(
                    HttpServerResponse.fromWeb(
                      new Response(archive.body, {
                        headers: {
                          "content-type": "application/zip",
                          "skit-release-version": release.version,
                          "cache-control":
                            release.visibility === "public" && target.version !== "latest"
                              ? "public, max-age=31536000, immutable"
                              : release.visibility === "public"
                                ? "public, no-cache"
                                : "private, no-store",
                        },
                      }),
                    ),
                  ),
          }),
        );
      },
    }),
  );
});

export const downloadRelease = Effect.fn("ReleaseHttp.downloadAuthenticated")(function* (target: {
  readonly owner: string;
  readonly slug: string;
  readonly version: string;
}) {
  return yield* download(target, {
    authentication: yield* Authentication,
    authorization: yield* Authorization,
  });
});

export const downloadReleaseAnonymous = Effect.fn("ReleaseHttp.downloadAnonymous")(
  function* (target: { readonly owner: string; readonly slug: string; readonly version: string }) {
    return yield* download(target);
  },
);
