import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

export const ReleaseNotFoundResponse = Schema.Struct({
  error: Schema.Literal("release_not_found"),
}).pipe(HttpApiSchema.status(404));
export const ArchiveNotFoundResponse = Schema.Struct({
  error: Schema.Literal("archive_not_found"),
}).pipe(HttpApiSchema.status(404));
export const ReleaseStorageFailureResponse = Schema.Struct({
  error: Schema.Literal("storage_failure"),
}).pipe(HttpApiSchema.status(500));

export class ReleaseDownloadApi extends HttpApiGroup.make("releaseDownloads").add(
  HttpApiEndpoint.get("download", "/api/skits/:owner/:slug/releases/:version/download", {
    params: { owner: Schema.String, slug: Schema.String, version: Schema.String },
    success: HttpApiSchema.StreamUint8Array({ contentType: "application/zip" }),
    error: [ReleaseNotFoundResponse, ArchiveNotFoundResponse, ReleaseStorageFailureResponse],
  }),
) {}
export class ReleaseApi extends HttpApi.make("skit-release-api").add(ReleaseDownloadApi) {}
