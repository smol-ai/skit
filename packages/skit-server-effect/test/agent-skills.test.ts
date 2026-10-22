import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { unzipSync, zipSync } from "fflate";
import { measureSkillProjection, projectionIndex } from "@smolai/skit-core/universal/consumer";
import { makeWebHandler } from "../src/http.js";
import { discoverableSkills, skillArtifact } from "../src/releases/agent-skills.js";
import { databaseLayer } from "../src/platform/cloudflare.js";

const web = makeWebHandler(env);

const webPromise = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test helper owns that host boundary.
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(Effect.orDie);

const request = (path: string) =>
  webPromise(() => web.handler(new Request(`https://registry.test${path}`)));

const bytesOf = (response: Response) =>
  webPromise(() => response.arrayBuffer()).pipe(Effect.map((buffer) => new Uint8Array(buffer)));

const sha256 = (bytes: Uint8Array<ArrayBuffer>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Web Crypto is Promise-only; this fixture helper owns the host boundary.
  webPromise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map(
      (digest) =>
        `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    ),
  );

const text = (value: string) => new TextEncoder().encode(value);

const skill = (name: string, shared: Array<{ from: string; to: string }> = []) => ({
  name,
  path: `skills/${name}`,
  default_enabled: true,
  shared,
});

/** Publishes `skills` as the latest public Release of tim/tools, with one shared reference file. */
const publishRelease = (skills: ReadonlyArray<ReturnType<typeof skill>>, sharedBytes: number) =>
  Effect.gen(function* () {
    const archive = zipSync({
      "skit.json": text(JSON.stringify({ slug: "tools", skills })),
      "shared/reference.bin": new Uint8Array(sharedBytes),
      ...Object.fromEntries(
        skills.map((entry) => [
          `${entry.path}/SKILL.md`,
          text(`---\nname: ${entry.name}\ndescription: ${entry.name} for tests\n---\n# Test\n`),
        ]),
      ),
    });
    yield* webPromise(() => env.SKIT_BLOBS.put("releases/tim/tools/1.0.0.zip", archive));
    yield* Effect.flatMap(D1Client.D1Client, (sql) =>
      sql.batch([
        sql.unsafe("DROP TABLE IF EXISTS releases"),
        sql.unsafe(`CREATE TABLE releases (
          owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, version TEXT NOT NULL,
          release_id TEXT NOT NULL UNIQUE, archive_object_key TEXT NOT NULL UNIQUE,
          published_at TEXT NOT NULL, visibility TEXT NOT NULL,
          PRIMARY KEY (owner_slug, skit_slug, version)
        )`),
        sql.unsafe(`INSERT INTO releases VALUES ('tim', 'tools', '1.0.0', 'release_1',
          'releases/tim/tools/1.0.0.zip', '2026-10-01T00:00:00.000Z', 'public')`),
      ]),
    );
  }).pipe(Effect.provide(Layer.orDie(databaseLayer(env.DB))));

const Index = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({ name: Schema.String, url: Schema.String, digest: Schema.String }),
  ),
});

describe("Agent Skills discovery", () => {
  it.effect("measures exactly the archive a Skill is served as", () =>
    Effect.gen(function* () {
      const shared = [
        { from: "shared/reference.md", to: "references/réf.md" },
        { from: "shared/assets", to: "assets" },
      ];
      const files = {
        "skit.json": text(
          JSON.stringify({ slug: "tools", skills: [skill("review", shared), skill("lint")] }),
        ),
        "skills/review/SKILL.md": text("---\nname: review\ndescription: Reviews\n---\n"),
        "skills/review/notes/empty.md": new Uint8Array(0),
        "skills/lint/SKILL.md": text("---\nname: lint\ndescription: Lints\n---\n"),
        "shared/reference.md": text("reference"),
        "shared/assets/font.ttf": new Uint8Array(300),
        "shared/assets/nested/icon.svg": text("<svg/>"),
      };
      const index = projectionIndex(
        Object.entries(files).map(([path, bytes]) => ({ path, bytes })),
      );
      const limit = { entries: Number.MAX_SAFE_INTEGER, archiveBytes: Number.MAX_SAFE_INTEGER };

      for (const served of yield* discoverableSkills(zipSync(files))) {
        const archive = yield* skillArtifact(served);
        expect(
          measureSkillProjection(
            index,
            `skills/${served.name}`,
            served.name === "review" ? shared : [],
            limit,
          ),
        ).toEqual({ entries: served.files.size, archiveBytes: archive.byteLength });
      }
    }),
  );
  it.effect("indexes each Skill with the digest of the archive it serves", () =>
    Effect.gen(function* () {
      yield* publishRelease(
        [
          skill("lint"),
          skill("review", [{ from: "shared/reference.bin", to: "references/reference.bin" }]),
        ],
        16,
      );
      const index = Schema.decodeUnknownSync(Index)(
        JSON.parse(
          new TextDecoder().decode(
            yield* bytesOf(yield* request("/tim/tools/.well-known/agent-skills/index.json")),
          ),
        ),
      );

      expect(index.skills.map(({ name }) => name)).toEqual(["lint", "review"]);
      for (const entry of index.skills) {
        const artifact = yield* bytesOf(yield* request(entry.url));
        expect(yield* sha256(artifact)).toBe(entry.digest);
      }
      const review = yield* bytesOf(yield* request("/tim/tools/skills/review/skill.zip"));
      expect(Object.keys(unzipSync(review)).sort()).toEqual([
        "SKILL.md",
        "references/reference.bin",
      ]);
    }),
  );

  it.effect("returns 404 for a Skill the Release does not declare", () =>
    Effect.gen(function* () {
      yield* publishRelease([skill("lint")], 16);

      expect((yield* request("/tim/tools/skills/missing/skill.zip")).status).toBe(404);
    }),
  );

  // Releases published before projection limits may exceed them; discovery refuses to build them.
  for (const [label, sharedBytes, skills] of [
    [
      "one Skill projects more than 1,000 entries of an empty file",
      0,
      [
        skill(
          "wide",
          Array.from({ length: 1_001 }, (_, copy) => ({
            from: "shared/reference.bin",
            to: `copy-${copy}.bin`,
          })),
        ),
      ],
    ],
    [
      "one Skill projects more than 8 MiB",
      1024 * 1024,
      [
        skill(
          "big",
          Array.from({ length: 9 }, (_, copy) => ({
            from: "shared/reference.bin",
            to: `copy-${copy}.bin`,
          })),
        ),
      ],
    ],
    [
      "its Skills together project more than 32 MiB",
      1024 * 1024,
      Array.from({ length: 5 }, (_, index) =>
        skill(
          `part-${index}`,
          Array.from({ length: 7 }, (_, copy) => ({
            from: "shared/reference.bin",
            to: `copy-${copy}.bin`,
          })),
        ),
      ),
    ],
  ] as const)
    it.effect(`refuses to serve a Release where ${label}`, () =>
      Effect.gen(function* () {
        yield* publishRelease(skills, sharedBytes);

        expect((yield* request("/tim/tools/.well-known/agent-skills/index.json")).status).toBe(404);
        expect((yield* request(`/tim/tools/skills/${skills[0]!.name}/skill.zip`)).status).toBe(404);
      }),
    );
});
