import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, FileSystem } from "effect";
import {
  RegistryAccounts,
  type AuthConfig,
  officialRegistryOrigin,
} from "../src/registry/accounts.js";
import { resolveAuthEffect, reuseLoginEffect } from "../src/registry/auth.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";
import { testPlatformLayer } from "./helpers/platform.js";

const one = "https://one.example";
const two = "https://two.example";
const credential = {
  token: "stored",
  tokenId: "id",
  tokenPrefix: "stored",
  scopes: ["library:sync"],
};
const config: AuthConfig = {
  schemaVersion: 1,
  registryAliases: { work: one, mirror: two },
  defaultRegistry: "work",
  servers: { [one]: credential, [two]: { ...credential, token: "second" } },
};

it.effect("names the different ambient, explicit, login, and logout selection rules", () =>
  Effect.gen(function* () {
    const accounts = new RegistryAccounts(config, { origin: two, token: "environment" });
    expect(yield* accounts.select(undefined, "ambient")).toBe(two);
    expect(yield* accounts.select("work", "ambient")).toBe(one);
    expect(yield* accounts.select("mirror", "ambient", { durableOrigin: one })).toBe(one);
    expect(yield* accounts.select(undefined, "explicit")).toBeUndefined();
    expect(yield* accounts.select("https://one.example/path", "explicit")).toBe(one);
    // Login follows ambient precedence: the environment, then the default, then the hosted Registry.
    expect(yield* accounts.loginTarget()).toBe(two);
    expect(yield* new RegistryAccounts(config).loginTarget()).toBe(one);
    expect(yield* Effect.flip(accounts.select(undefined, "logout"))).toMatchObject({
      _tag: "RegistrySelectionAmbiguous",
      origins: [one, two],
      command: "skit auth logout <origin-or-alias>",
    });
    expect(yield* accounts.select("mirror", "logout")).toBe(two);
    expect(yield* Effect.flip(accounts.select("typo", "explicit"))).toMatchObject({
      _tag: "RegistryAliasNotFound",
      name: "typo",
    });

    const empty = new RegistryAccounts({ schemaVersion: 1, servers: {} });
    expect(yield* empty.select(undefined, "ambient")).toBeUndefined();
    expect(yield* empty.loginTarget()).toBe(officialRegistryOrigin);
    expect(
      yield* new RegistryAccounts({ schemaVersion: 1, servers: {} }, { origin: two }).loginTarget(),
    ).toBe(two);
    expect(yield* Effect.flip(accounts.loginTarget("http://remote.example"))).toMatchObject({
      _tag: "InsecureOrigin",
    });
    const sole = new RegistryAccounts(
      { schemaVersion: 1, servers: { [one]: credential } },
      { origin: two },
    );
    expect(yield* sole.select(undefined, "logout")).toBe(one);
  }),
);

it.effect(
  "uses environment credentials only for the matching origin without inheriting stored metadata",
  () =>
    Effect.gen(function* () {
      for (const [environment, origin, source, token] of [
        [
          { origin: `${two}/path`, token: "environment-token-that-is-long" },
          two,
          "environment",
          "environment-token-that-is-long",
        ],
        [{ origin: two, token: "environment" }, one, "stored", "stored"],
        [{ origin: one }, one, "stored", "stored"],
        [{ token: "unscoped" }, one, "stored", "stored"],
        [{}, "https://unknown.example", "none", undefined],
      ] as const) {
        const auth = yield* new RegistryAccounts(config, environment).credential(origin);
        expect(auth).toMatchObject({ origin, source, token });
        if (source === "environment") {
          expect(auth.tokenPrefix).toBe(token.slice(0, 18));
          expect(auth.tokenId).toBeUndefined();
          expect(auth.scopes).toBeUndefined();
          expect(auth.expiresAt).toBeUndefined();
        }
      }
    }),
);

it.effect(
  "keeps alias allocation, sole-account promotion, and explicit default removal in account edits",
  () =>
    Effect.gen(function* () {
      const original: AuthConfig = {
        schemaVersion: 1,
        activeOrigin: two,
        registryAliases: { default: two, "default-2": two },
        servers: {},
      };
      const accounts = new RegistryAccounts(original);
      const signedIn = accounts.signedIn(one, credential);
      expect(signedIn).toMatchObject({ alias: "default-3", defaultRegistry: "default-3" });
      expect(signedIn.config).not.toHaveProperty("activeOrigin");
      expect(original.servers).toEqual({});
      expect(yield* Effect.flip(accounts.checkLoginAlias(one, "default"))).toMatchObject({
        _tag: "RegistryAliasConflict",
      });
      const removed = yield* new RegistryAccounts(signedIn.config).removeAlias("default-3");
      expect(removed.config).not.toHaveProperty("defaultRegistry");
      expect(removed.config.servers[one]).toEqual(credential);
      const promoted = yield* new RegistryAccounts(removed.config).addAlias("work", one);
      expect(promoted.config.defaultRegistry).toBe("work");
      expect(new RegistryAccounts(promoted.config).signedOut(one).servers).toEqual({});
    }),
);

it.effect("resolves selection and credential from a single file read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let reads = 0;
    const auth = yield* resolveAuthEffect("/accounts", "work").pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: () =>
          Effect.sync(() => {
            reads++;
            return JSON.stringify(
              reads === 1 ? config : { ...config, registryAliases: { work: two } },
            );
          }),
      }),
    );
    expect(auth).toMatchObject({ origin: one, token: "stored", source: "stored" });
    expect(reads).toBe(1);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("login reuse checks the credential and alias from the same file snapshot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let reads = 0;
    const result = yield* Effect.scoped(
      reuseLoginEffect({
        origin: one,
        alias: "work",
        scopes: ["library:sync"],
        home: "/accounts",
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: () =>
          Effect.sync(() => {
            reads++;
            return JSON.stringify(
              reads === 1 ? config : { ...config, registryAliases: { work: two } },
            );
          }),
      }),
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer((request) => {
            expect(request.headers.authorization).toBe("Bearer stored");
            return Effect.succeed(Response.json({ error: "library_not_found" }, { status: 404 }));
          }),
        ),
      ),
    );
    expect(result).toMatchObject({ origin: one, alias: "work", alreadyAuthenticated: true });
    expect(reads).toBe(1);
  }).pipe(Effect.provide(testPlatformLayer)),
);
