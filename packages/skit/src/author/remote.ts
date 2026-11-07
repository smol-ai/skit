import { Effect, Schema } from "effect";
import {
  normalizeRegistryNamespace,
  normalizeRegistrySkitSlug,
} from "../artifact/registry-identity.js";
import {
  AuthorDestinationInvalid,
  AuthorDestinationMalformed,
  InsecureOrigin,
} from "./failures.js";

/**
 * skit.remote.v1: a SKIT's Registry home, origin + namespace + skit (ADR-0010, ADR-0011).
 * Excess properties are an error: this document is exhaustive, and the previous reader rejected
 * any key set but these four.
 */
export const AuthorRemoteHome = Schema.Struct({
  schema: Schema.Literal("skit.remote.v1"),
  origin: Schema.String,
  namespace: Schema.String,
  skit: Schema.String,
});
export type AuthorRemoteHome = typeof AuthorRemoteHome.Type;

export const decodeUrl = (input: string) =>
  Schema.decodeUnknownEffect(Schema.URLFromString)(input).pipe(
    Effect.mapError(() => new AuthorDestinationMalformed({ message: "Invalid URL" })),
  );

/** The canonical form of a remote home: an https origin (or local http) and normalized names. */
export const normalizeRemote = Effect.fn("Author.normalizeRemote")(function* (
  value: Omit<AuthorRemoteHome, "schema">,
) {
  const origin = (yield* decodeUrl(value.origin)).origin;
  if (
    !origin.startsWith("https://") &&
    !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
  )
    return yield* new InsecureOrigin({ purpose: "author remote" });
  const namespace = normalizeRegistryNamespace(value.namespace);
  const skit = normalizeRegistrySkitSlug(value.skit);
  if (!namespace || !skit) return yield* new AuthorDestinationInvalid({ form: "bare" });
  return AuthorRemoteHome.make({ schema: "skit.remote.v1", origin, namespace, skit });
});

export const AuthorVisibility = Schema.Literals(["private", "unlisted", "public"]);
export type AuthorVisibility = typeof AuthorVisibility.Type;
