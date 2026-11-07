import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Identity, type IdentityService } from "../identity/service.js";
import { Skits } from "../skits/service.js";

const errorResponse = (error: string, status: number) =>
  HttpServerResponse.json({ error }, { status, headers: { "cache-control": "no-store" } }).pipe(
    Effect.orDie,
  );

const download = Effect.fn("ReleaseHttp.download")(function* (
  target: { readonly owner: string; readonly slug: string; readonly version: string },
  authentication?: IdentityService,
) {
  const releases = (yield* Skits).releases;
  const request = authentication ? yield* HttpServerRequest.HttpServerRequest : undefined;
  const authenticate =
    authentication && request
      ? HttpServerRequest.toWeb(request).pipe(
          Effect.flatMap(authentication.authenticate),
          Effect.tapError((error) =>
            Effect.logError("release download authentication failed", error),
          ),
        )
      : undefined;
  const lookup = releases.findDownload(target, authenticate);

  return yield* lookup.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logError("release lookup failed", error).pipe(
          Effect.andThen(errorResponse("storage_failure", 500)),
        ),
      onSuccess: (release) => {
        if (release === null) return errorResponse("release_not_found", 404);
        return release.archive.stream.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.logError("release archive read failed", error).pipe(
                Effect.andThen(errorResponse("storage_failure", 500)),
              ),
            onSuccess: (archive) =>
              Option.isNone(archive)
                ? errorResponse("archive_not_found", 404)
                : Effect.succeed(
                    HttpServerResponse.fromWeb(
                      new Response(archive.value, {
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
  return yield* download(target, yield* Identity);
});

export const downloadReleaseAnonymous = Effect.fn("ReleaseHttp.downloadAnonymous")(
  function* (target: { readonly owner: string; readonly slug: string; readonly version: string }) {
    return yield* download(target);
  },
);
