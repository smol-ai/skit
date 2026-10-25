import { Effect, Schema } from "effect";
import {
  InsecureOrigin,
  RegistryAliasConflict,
  RegistryAliasInvalid,
  RegistryAliasNotFound,
  RegistryOriginInvalid,
  RegistrySelectionAmbiguous,
} from "./failures.js";

/**
 * `scopes` decodes as plain strings, not the AUTH_SCOPES union: those literals say what this CLI
 * may request at login, not what a Registry may have granted. A scope this build does not know
 * about must not render the whole credential file unusable.
 */
export const StoredCredential = Schema.Struct({
  /** Absent when the token lives in the OS store named by `tokenStorage`. */
  token: Schema.optionalKey(Schema.String),
  tokenStorage: Schema.optionalKey(Schema.Literals(["keychain", "secret-service"])),
  tokenId: Schema.String,
  tokenPrefix: Schema.String,
  scopes: Schema.Array(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
});

export const AuthConfig = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    activeOrigin: Schema.optionalKey(Schema.String),
    defaultRegistry: Schema.optionalKey(Schema.String),
    registryAliases: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    servers: Schema.Record(Schema.String, StoredCredential),
  }),
);

export type StoredCredential = typeof StoredCredential.Type;
export type AuthConfig = typeof AuthConfig.Type;

export type ResolvedAuth = {
  origin?: string;
  token?: string;
  tokenId?: string;
  tokenPrefix?: string;
  scopes?: readonly string[];
  expiresAt?: string;
  source: "environment" | "stored" | "none";
};

type AuthStatusCredential = {
  origin: string;
  aliases: string[];
  tokenPrefix: string;
  scopes: readonly string[];
  expiresAt?: string;
  expiry: "known" | "unknown";
  expired: boolean;
  isDefault: boolean;
  source: "stored" | "environment";
  storage: "keychain" | "secret-service" | "file" | "environment";
};

// URL syntax errors retain their generic command classification; programming defects do not.
export const parseOrigin = (input: string) =>
  Schema.decodeUnknownEffect(Schema.URLFromString)(input).pipe(
    Effect.map((url) => url.origin),
    Effect.mapError(() => new RegistryOriginInvalid({ origin: input })),
  );

export const validateAuthenticationOrigin = Effect.fnUntraced(function* (input: string) {
  const origin = yield* parseOrigin(input).pipe(
    Effect.mapError(() => new InsecureOrigin({ purpose: "authentication" })),
  );
  if (
    !origin.startsWith("https://") &&
    !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
  )
    return yield* new InsecureOrigin({ purpose: "authentication" });
  return origin;
});

export type AccountEnvironment = { readonly origin?: string; readonly token?: string };

/**
 * smol.ai's hosted SKIT Registry: where `skit auth login` signs in, and where `skit:` shorthand
 * resolves, when nothing else is configured. An argument, `SKIT_SERVER_URL` or a configured default
 * Registry always takes precedence, so self-hosting needs no change.
 */
export const officialRegistryOrigin = "https://skit.smol.ai";

/** Environment credentials may be used even when the credential file is unusable. */
export const environmentCredential = Effect.fn("RegistryAccounts.environmentCredential")(function* (
  environment: AccountEnvironment,
  origin?: string,
): Effect.fn.Return<ResolvedAuth | undefined, RegistryOriginInvalid> {
  const environmentOrigin = environment.origin ? yield* parseOrigin(environment.origin) : undefined;
  if (environment.token && environmentOrigin === origin)
    return {
      origin,
      token: environment.token,
      tokenPrefix: environment.token.slice(0, 18),
      source: "environment",
    };
  return undefined;
});

const validateAlias = (name: string) =>
  /^[a-z][a-z0-9-]*$/.test(name)
    ? Effect.succeed(name)
    : Effect.fail(new RegistryAliasInvalid({ name }));

/** One immutable decoded account snapshot. No filesystem, environment reads, or network IO. */
export class RegistryAccounts {
  constructor(
    private readonly config: AuthConfig,
    private readonly environment: AccountEnvironment = {},
  ) {}

  get defaultRegistry() {
    return this.config.defaultRegistry;
  }
  get defaultOrigin() {
    return this.config.defaultRegistry
      ? this.config.registryAliases?.[this.config.defaultRegistry]
      : undefined;
  }
  stored(origin: string) {
    return this.config.servers[origin];
  }
  aliasesOf(origin: string) {
    return Object.entries(this.config.registryAliases ?? {})
      .filter(([, value]) => value === origin)
      .map(([name]) => name);
  }
  hasAlias(name: string, origin: string) {
    return this.config.registryAliases?.[name] === origin;
  }
  remotes() {
    return Object.entries(this.config.registryAliases ?? {}).map(([name, origin]) => ({
      name,
      origin,
      isDefault: this.config.defaultRegistry === name,
    }));
  }
  private alias(name: string) {
    const origin = this.config.registryAliases?.[name];
    return origin ? Effect.succeed(origin) : Effect.fail(new RegistryAliasNotFound({ name }));
  }

  /** Explicit ignores defaults/env; logout uses stored accounts only. */
  select = Effect.fn("RegistryAccounts.select")(function* (
    this: RegistryAccounts,
    selector: string | undefined,
    policy: "ambient" | "explicit" | "logout",
    options: { readonly durableOrigin?: string; readonly command?: string } = {},
  ) {
    if (options.durableOrigin) return yield* parseOrigin(options.durableOrigin);
    if (selector)
      return yield* selector.includes("://") ? parseOrigin(selector) : this.alias(selector);
    if (policy === "explicit") return undefined;
    if (policy === "ambient") {
      if (this.environment.origin) return yield* parseOrigin(this.environment.origin);
      if (this.defaultOrigin) return this.defaultOrigin;
    }
    const origins = Object.keys(this.config.servers).sort();
    if (origins.length === 1) return origins[0];
    if (origins.length > 1)
      return yield* new RegistrySelectionAmbiguous({
        origins,
        command:
          policy === "logout"
            ? "skit auth logout <origin-or-alias>"
            : `${options.command ?? "skit <command>"} --registry <alias-or-origin>`,
      });
    return undefined;
  });

  loginTarget = Effect.fn("RegistryAccounts.loginTarget")(function* (
    this: RegistryAccounts,
    selector?: string,
  ) {
    if (selector?.includes("://")) return yield* validateAuthenticationOrigin(selector);
    if (selector) return yield* validateAuthenticationOrigin(yield* this.alias(selector));
    // The same precedence as ambient selection: the environment, then the configured default.
    const configured = this.environment.origin ?? this.defaultOrigin;
    return yield* validateAuthenticationOrigin(configured ?? officialRegistryOrigin);
  });

  credential = Effect.fn("RegistryAccounts.credential")(function* (
    this: RegistryAccounts,
    origin?: string,
  ): Effect.fn.Return<ResolvedAuth, RegistryOriginInvalid> {
    const environment = yield* environmentCredential(this.environment, origin);
    if (environment) return environment;
    const stored = origin ? this.stored(origin) : undefined;
    return {
      origin,
      token: stored?.token,
      tokenId: stored?.tokenId,
      tokenPrefix: stored?.tokenPrefix,
      scopes: stored?.scopes,
      expiresAt: stored?.expiresAt,
      source: stored ? "stored" : "none",
    };
  });

  status = Effect.fn("RegistryAccounts.status")(function* (
    this: RegistryAccounts,
    selector: string | undefined,
    now: number,
  ) {
    const selectedOrigin = yield* this.select(selector, "explicit");
    const credentials: AuthStatusCredential[] = Object.entries(this.config.servers)
      .filter(([origin]) => !selectedOrigin || origin === selectedOrigin)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([origin, credential]) => ({
        origin,
        aliases: this.aliasesOf(origin).sort(),
        tokenPrefix: credential.tokenPrefix,
        scopes: credential.scopes,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        expiry: credential.expiresAt ? "known" : "unknown",
        expired: credential.expiresAt ? Date.parse(credential.expiresAt) <= now : false,
        isDefault: this.defaultOrigin === origin,
        source: "stored",
        storage: credential.tokenStorage ?? "file",
      }));
    const origin = this.environment.origin
      ? yield* parseOrigin(this.environment.origin)
      : undefined;
    const environment = yield* environmentCredential(this.environment, origin);
    if (origin && environment?.tokenPrefix && (!selectedOrigin || selectedOrigin === origin))
      credentials.push({
        origin,
        aliases: [],
        tokenPrefix: environment.tokenPrefix,
        scopes: [],
        expiry: "unknown",
        expired: false,
        isDefault: this.defaultOrigin === origin,
        source: "environment",
        storage: "environment",
      });
    return { credentials };
  });

  checkLoginAlias = Effect.fn("RegistryAccounts.checkLoginAlias")(function* (
    this: RegistryAccounts,
    origin: string,
    alias?: string,
  ) {
    if (!alias) return;
    yield* validateAlias(alias);
    const existing = this.config.registryAliases?.[alias];
    if (existing && existing !== origin) return yield* new RegistryAliasConflict({ name: alias });
  });

  private allocateAlias(origin: string) {
    const existing = this.aliasesOf(origin)[0];
    if (existing) return existing;
    let name =
      origin === officialRegistryOrigin && !this.config.registryAliases?.smol ? "smol" : "default";
    for (
      let suffix = 2;
      this.config.registryAliases?.[name] && !this.hasAlias(name, origin);
      suffix++
    )
      name = `default-${suffix}`;
    return name;
  }

  /** Serialization drops legacy activeOrigin; mutations normally promote a sole saved Registry. */
  private next(config: AuthConfig, promoteSole = true): AuthConfig {
    const { activeOrigin: _legacy, ...current } = config;
    const origins = Object.keys(current.servers);
    if (!promoteSole || current.defaultRegistry || origins.length !== 1) return current;
    const accounts = new RegistryAccounts(current);
    const name = accounts.allocateAlias(origins[0]);
    return {
      ...current,
      registryAliases: { ...current.registryAliases, [name]: origins[0] },
      defaultRegistry: name,
    };
  }

  signedIn(origin: string, credential: StoredCredential, alias?: string) {
    const firstRegistry = Object.keys(this.config.servers).length === 0 && !this.defaultRegistry;
    const initialAlias = alias ?? this.allocateAlias(origin);
    const configuredAlias = alias ?? (firstRegistry ? initialAlias : undefined);
    return {
      config: this.next({
        ...this.config,
        ...(configuredAlias
          ? { registryAliases: { ...this.config.registryAliases, [configuredAlias]: origin } }
          : {}),
        ...(firstRegistry ? { defaultRegistry: initialAlias } : {}),
        servers: { ...this.config.servers, [origin]: credential },
      }),
      ...(configuredAlias ? { alias: configuredAlias } : {}),
      ...(firstRegistry ? { defaultRegistry: initialAlias } : {}),
    };
  }
  signedOut(origin: string) {
    const { [origin]: _removed, ...servers } = this.config.servers;
    return this.next({ ...this.config, servers });
  }
  addAlias = Effect.fn("RegistryAccounts.addAlias")(function* (
    this: RegistryAccounts,
    name: string,
    originInput: string,
  ) {
    yield* validateAlias(name);
    const origin = yield* parseOrigin(originInput);
    if (this.config.registryAliases?.[name]) return yield* new RegistryAliasConflict({ name });
    return {
      config: this.next({
        ...this.config,
        registryAliases: { ...this.config.registryAliases, [name]: origin },
      }),
      remote: { name, origin, isDefault: false },
    };
  });
  setDefault = Effect.fn("RegistryAccounts.setDefault")(function* (
    this: RegistryAccounts,
    name: string,
  ) {
    yield* validateAlias(name);
    const origin = yield* this.alias(name);
    return {
      config: this.next({ ...this.config, defaultRegistry: name }),
      remote: { name, origin, isDefault: true },
    };
  });
  removeAlias = Effect.fn("RegistryAccounts.removeAlias")(function* (
    this: RegistryAccounts,
    name: string,
  ) {
    yield* validateAlias(name);
    const origin = yield* this.alias(name);
    const { [name]: _removed, ...registryAliases } = this.config.registryAliases ?? {};
    const { defaultRegistry: _default, ...withoutDefault } = this.config;
    return {
      config: this.next(
        this.defaultRegistry === name
          ? { ...withoutDefault, registryAliases }
          : { ...this.config, registryAliases },
        false,
      ),
      remote: { name, origin, isDefault: false },
    };
  });
}
