import { describe } from "@effect/vitest";
import {
  registryCredentials,
  addRegistryRemote,
  defaultRegistryRemote,
  listRegistryRemotes,
  removeRegistryRemote,
  resolveRegistryLocator,
} from "../src/registry/auth.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect } from "vitest";

import { scratch } from "./helpers/library-home.js";

describe("skit registry remove", () => {
  describe("Removing the default Registry name clears that default.", () => {
    it.effect("removing the default alias does not recreate it for a sole credential", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* scratch("skit-registry-remove-default-");
        yield* fs.writeFileString(
          join(home, "auth.json"),
          JSON.stringify({
            schemaVersion: 1,
            defaultRegistry: "work",
            registryAliases: { work: "https://registry.example" },
            servers: {
              "https://registry.example": {
                token: "secret",
                tokenId: "token-id",
                tokenPrefix: "secret",
                scopes: ["library:sync"],
              },
            },
          }),
        );

        yield* removeRegistryRemote("work", home);
        const stored = JSON.parse(yield* fs.readFileString(join(home, "auth.json")));
        expect(stored.registryAliases).toEqual({});
        expect(stored).not.toHaveProperty("defaultRegistry");
      }).pipe(Effect.provide(testPlatformLayer)),
    );

    it.effect("removing a Registry name clears its default routing", () =>
      Effect.gen(function* () {
        const home = yield* scratch("skit-registry-remotes-");

        yield* addRegistryRemote("public", "https://registry.example/path", home);

        yield* defaultRegistryRemote("public", home);

        yield* removeRegistryRemote("public", home);

        expect(yield* listRegistryRemotes(home)).toEqual([]);

        const stored = yield* (yield* FileSystem.FileSystem).readFileString(
          join(home, "auth.json"),
        );

        expect(JSON.parse(stored)).not.toHaveProperty("defaultRegistry");
      }).pipe(Effect.provide(testPlatformLayer)),
    );
  });
});

describe("skit registry add", () => {
  describe("A Registry name resolves to its origin.", () => {
    it.effect("a Registry name resolves without becoming a portable authority", () =>
      Effect.gen(function* () {
        const home = yield* scratch("skit-registry-remotes-");

        yield* addRegistryRemote("public", "https://registry.example/path", home);

        expect(
          yield* resolveRegistryLocator("skit:humanlayer/skills", {
            registry: "public",
            home,
          }),
        ).toMatchObject({
          input: "skit:humanlayer/skills",
          origin: "https://registry.example",
        });

        expect(
          yield* resolveRegistryLocator("skit:humanlayer/skills", {
            registry: "https://other.example/path",
            home,
          }),
        ).toMatchObject({ input: "skit:humanlayer/skills", origin: "https://other.example" });

        expect(
          yield* resolveRegistryLocator("skit://registry.example/humanlayer/skills", { home }),
        ).toMatchObject({
          input: "skit://registry.example/humanlayer/skills",
          origin: "https://registry.example",
        });

        expect(
          yield* Effect.flip(
            resolveRegistryLocator("skit:humanlayer/skills", {
              registry: "wrok",
              home,
            }),
          ),
        ).toMatchObject({ _tag: "RegistryAliasNotFound", alias: "wrok" });
      }).pipe(Effect.provide(testPlatformLayer)),
    );
  });
});

describe("skit registry default", () => {
  describe("Registry shorthand uses the selected default Registry.", () => {
    it.effect("the configured default selects the Registry credential origin", () =>
      Effect.gen(function* () {
        const home = yield* scratch("skit-registry-remotes-");

        yield* addRegistryRemote("public", "https://registry.example/path", home);

        yield* defaultRegistryRemote("public", home);

        expect(yield* registryCredentials({ home })).toMatchObject({
          origin: "https://registry.example",
        });
      }).pipe(Effect.provide(testPlatformLayer)),
    );
  });
});

describe("skit registry list", () => {
  describe("Registry list identifies the default among configured names.", () => {
    it.effect("named Registries identify the configured default", () =>
      Effect.gen(function* () {
        const home = yield* scratch("skit-registry-remotes-");

        yield* addRegistryRemote("public", "https://registry.example/path", home);

        yield* defaultRegistryRemote("public", home);

        expect(yield* listRegistryRemotes(home)).toEqual([
          { name: "public", origin: "https://registry.example", isDefault: true },
        ]);
      }).pipe(Effect.provide(testPlatformLayer)),
    );
  });
});
