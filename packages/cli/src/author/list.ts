import { SkitContractError, type AuthorSkitListResponse } from "@smolai/skit-core/api";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { Data, Effect, Result, Scope } from "effect";

import { type ResolvedAuth } from "../registry/index.js";
import { RegistryHttp } from "../registry/registry-http.js";
import { authorInventoryApi, AuthorListResponseError } from "../registry/authoring.js";
import { Renderer } from "../terminal/renderer.js";
import { skitLocator } from "./destination.js";
import {
  AuthenticationRequired,
  CredentialLacksScope,
  RegistryOriginInvalid,
  RegistryUnreachable,
} from "../registry/failures.js";

import { outputContracts } from "../commands/output-contracts.js";

export type AuthorSkitInventory = typeof outputContracts.authorList.schema.Type;

class AuthorListPaginationError
  extends Data.TaggedError("AuthorListPaginationError")<{
    origin: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Retry; if it persists, report the Registry's inventory to its operator.";
  get message() {
    return `Registry ${this.origin} returned non-progressing or excessive inventory pages`;
  }
}
export class AuthorListIdentityError
  extends Data.TaggedError("AuthorListIdentityError")<{
    identity: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Report the invalid identity to the Registry's operator.";
  get message() {
    return `Registry returned invalid SKIT identity: ${this.identity}`;
  }
}
export type AuthorListFailure =
  | AuthenticationRequired
  | CredentialLacksScope
  | RegistryUnreachable
  | AuthorListResponseError
  | SkitContractError
  | AuthorListPaginationError
  | AuthorListIdentityError
  | RegistryOriginInvalid;

export const listAuthorSkits = Effect.fn("listAuthorSkits")(function* (input: {
  origin?: string;
  token?: string;
}): Effect.fn.Return<AuthorSkitInventory, AuthorListFailure, RegistryHttp | Scope.Scope> {
  const api = yield* authorInventoryApi(input);
  const origin = api.origin;
  const skits: Array<AuthorSkitListResponse["skits"][number]> = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let pages = 0;
  do {
    const page: AuthorSkitListResponse = yield* api.readPage(cursor);
    skits.push(...page.skits);
    cursor = page.next_cursor;
    pages++;
    if (cursor && (cursors.has(cursor) || pages >= 1_000 || skits.length > 100_000))
      return yield* Effect.fail(new AuthorListPaginationError({ origin }));
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const inventory = yield* Effect.forEach(skits, (skit) =>
    Effect.gen(function* () {
      const separator = skit.skit_id.indexOf("/");
      if (separator < 1 || separator === skit.skit_id.length - 1)
        return yield* Effect.fail(new AuthorListIdentityError({ identity: skit.skit_id }));
      return {
        identity: skitLocator({
          schema: "skit.remote.v1",
          origin,
          namespace: skit.skit_id.slice(0, separator),
          skit: skit.skit_id.slice(separator + 1),
        }),
        visibility: skit.visibility,
        current_revision_id: skit.current_revision_id,
        current_revision_published: skit.current_revision_published,
        most_recent_release_version: skit.most_recent_release_version,
      };
    }),
  );
  return { registry: origin, skits: inventory };
}, Effect.scoped);

export interface AuthorListOptions<E> {
  readonly authState: Result.Result<ResolvedAuth, E>;
  readonly registry?: string;
  readonly home?: string;
}

export const authorListCommand = Effect.fn("CLI.authorList")(function* <E>(
  options: AuthorListOptions<E>,
) {
  const selected = yield* Effect.fromResult(options.authState);
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Listing authored SKITs",
    listAuthorSkits({ origin: selected.origin, token: selected.token }),
  );
});
