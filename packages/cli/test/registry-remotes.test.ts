import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect } from "vitest";
import { skitLayer } from "@smolai/skit-core";
import {
  addRegistryRemoteEffect,
  defaultRegistryRemoteEffect,
  listRegistryRemotesEffect,
  removeRegistryRemoteEffect,
  resolveAuthEffect,
  resolveRegistryLocatorEffect,
} from "../src/registry/auth.js";
import { scratch } from "./helpers/library-home.js";

it.effect("resolves local Registry names without persisting them as authorities", () =>
  Effect.gen(function* () {
    const home = yield* scratch("skit-registry-remotes-");
    yield* addRegistryRemoteEffect("public", "https://registry.example/path", home);
    yield* defaultRegistryRemoteEffect("public", home);

    expect(yield* listRegistryRemotesEffect(home)).toEqual([
      { name: "public", origin: "https://registry.example", isDefault: true },
    ]);
    expect(
      yield* resolveRegistryLocatorEffect("skit:humanlayer/skills", {
        registry: "public",
        home,
      }),
    ).toMatchObject({
      input: "skit:humanlayer/skills",
      origin: "https://registry.example",
    });
    expect(
      yield* resolveRegistryLocatorEffect("skit:humanlayer/skills", {
        registry: "https://other.example/path",
        home,
      }),
    ).toMatchObject({ input: "skit:humanlayer/skills", origin: "https://other.example" });
    expect(
      yield* resolveRegistryLocatorEffect("skit://registry.example/humanlayer/skills", { home }),
    ).toMatchObject({
      input: "skit://registry.example/humanlayer/skills",
      origin: "https://registry.example",
    });
    expect(
      yield* Effect.flip(
        resolveRegistryLocatorEffect("skit:humanlayer/skills", {
          registry: "wrok",
          home,
        }),
      ),
    ).toMatchObject({ _tag: "RegistryAliasNotFound", name: "wrok" });
    expect(yield* resolveAuthEffect(home)).toMatchObject({
      origin: "https://registry.example",
    });

    yield* removeRegistryRemoteEffect("public", home);
    expect(yield* listRegistryRemotesEffect(home)).toEqual([]);
    const stored = yield* (yield* FileSystem.FileSystem).readFileString(join(home, "auth.json"));
    expect(JSON.parse(stored)).not.toHaveProperty("defaultRegistry");
  }).pipe(Effect.provide(skitLayer)),
);

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

    yield* removeRegistryRemoteEffect("work", home);
    const stored = JSON.parse(yield* fs.readFileString(join(home, "auth.json")));
    expect(stored.registryAliases).toEqual({});
    expect(stored).not.toHaveProperty("defaultRegistry");
  }).pipe(Effect.provide(skitLayer)),
);
