import { AuthorDestinationInvalid, AuthorDestinationMalformed } from "./failures.js";
import { Effect, Schema } from "effect";
import { decodeUrl, normalizeRemote, type AuthorRemoteHome } from "./remote.js";
import { DestinationFormInvalid } from "./failures.js";

const decodeAuthorSegment = (input: string) =>
  Schema.decodeUnknownEffect(Schema.StringFromUriComponent)(input).pipe(
    Effect.mapError(() => new AuthorDestinationMalformed({ message: "URI malformed" })),
  );

export const parseAuthorDestination = Effect.fn("Author.parseDestination")(function* (
  input: string,
  registryOrigin?: string,
) {
  if (input.startsWith("skit://")) {
    const url = yield* decodeUrl(input);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || url.search || url.hash)
      return yield* new DestinationFormInvalid({ form: "canonical" });
    return yield* normalizeRemote({
      origin: `https://${url.host}`,
      namespace: yield* decodeAuthorSegment(parts[0]),
      skit: yield* decodeAuthorSegment(parts[1]),
    });
  }
  if (/^https?:\/\//.test(input)) {
    const url = yield* decodeUrl(input);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || url.search || url.hash)
      return yield* new AuthorDestinationInvalid({ form: "https" });
    return yield* normalizeRemote({
      origin: url.origin,
      namespace: yield* decodeAuthorSegment(parts[0]),
      skit: yield* decodeAuthorSegment(parts[1]),
    });
  }
  const parts = input.split("/");
  if (parts.length !== 2 || !registryOrigin)
    return yield* registryOrigin
      ? new AuthorDestinationInvalid({ form: "bare" })
      : new DestinationFormInvalid({ form: "relative-without-registry" });
  return yield* normalizeRemote({
    origin: registryOrigin,
    namespace: parts[0],
    skit: parts[1],
  });
});

export function skitLocator(remote: AuthorRemoteHome): string {
  const authority = new URL(remote.origin).host;
  return `skit://${authority}/${remote.namespace}/${remote.skit}`;
}
