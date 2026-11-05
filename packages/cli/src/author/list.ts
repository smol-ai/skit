import {
  SkitConfiguration,
  skitConfigurationLayer,
  SkitContractError,
  type AuthorSkitListResponse,
  FailureTypeId,
  type SkitFailure,
} from "@smolai/skit-core";
import { Data, Effect, Option, Result, Scope } from "effect";
import { Command } from "effect/cli";

import { Registry, type ResolvedAuth } from "../registry/index.js";
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
import { handleRegistryCommand } from "../commands/handler.js";

import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { homeFlag, jsonFlag, optionalString } from "../commands/parameters.js";
import { result } from "../commands/result.js";

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

const registry = optionalString("registry", "Select a Registry by alias or origin.");

export const authorListCliCommand = Command.make(
  "list",
  { registry, home: homeFlag, json: jsonFlag },
  ({ registry, home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handleRegistryCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const selectedRegistry = Option.getOrUndefined(registry);
          const authState = yield* Registry.credentials({
            home: selectedHome,
            registry: selectedRegistry,
            command: "skit author list",
          }).pipe(Effect.result);
          const value = yield* authorListCommand({
            authState,
            registry: selectedRegistry,
            home: selectedHome,
          });
          yield* renderer.result(result("authorList", value));
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("List SKITs the active Principal can author on a Registry."),
  Command.withExamples([
    { command: "skit author list" },
    { command: "skit author list --registry https://skit.example.com" },
    { command: "skit author list --json" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.authorList],
    exitCodes: [0, 12, 13, 64],
    interactive: false,
  }),
);
