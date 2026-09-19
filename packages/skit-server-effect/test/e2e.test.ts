import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { Schema } from "effect";
import { createTestHarness } from "wrangler";
import { expect, test } from "vitest";
import type { RuntimeEnv } from "../src/platform/cloudflare.js";
import { DraftReadResponse } from "../src/drafts/contracts.js";
import { expectedMigrations } from "../src/readiness/migrations.generated.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

const serverRoot = resolve(import.meta.dirname, "..");
const cli = join(repositoryRoot, "packages", "cli", "bin", "skit.js");
const deploymentVerifier = join(serverRoot, "scripts", "verify-deployment.mjs");
const fixtures = join(serverRoot, "test", "fixtures");
const commandsWithHarnessRoots = new Set([
  "add",
  "pull",
  "list",
  "inspect",
  "inventory",
  "doctor",
  "check",
  "update",
  "pin",
  "remove",
  "enable",
  "disable",
  "sync",
]);

test.skip("runs the pre-release authoring product loop through the built CLI", async () => {
  // The v1 CLI deliberately has no `author` command. Retain this scenario as executable design
  // evidence until it is replaced by a supported authoring client or removed with the pre-release
  // Draft and Publication surface; it is not part of the v1 E2E gate.
  let cliToken: string;
  const workspace = await mkdtemp(join(tmpdir(), "skit-e2e-"));
  const authorSource = join(workspace, "author-lifecycle");
  const authorHome = join(workspace, "author-home");
  const consumerHome = join(workspace, "consumer-home");
  const roots = {
    codex: join(workspace, "codex"),
    claude: join(workspace, "claude"),
    opencode: join(workspace, "opencode"),
    devin: join(workspace, "devin"),
  };
  const keepWorkspace = process.env.SKIT_E2E_KEEP === "1";
  const server = createTestHarness({
    root: serverRoot,
    workers: [
      {
        configPath: "./test/wrangler.test.jsonc",
        secrets: {
          BETTER_AUTH_SECRET: "skit-e2e-secret-that-is-at-least-thirty-two-characters",
          SKIT_BOOTSTRAP_SECRET: "skit-e2e-bootstrap-secret-that-is-at-least-thirty-two-characters",
        },
      },
    ],
  });

  function skit(args: string[], expectedStatus = 0) {
    const harnessRootArgs =
      commandsWithHarnessRoots.has(args[0]) || (args[0] === "author" && args[1] === "init")
        ? [
            "--codex-root",
            roots.codex,
            "--claude-root",
            roots.claude,
            "--opencode-root",
            roots.opencode,
            "--devin-root",
            roots.devin,
          ]
        : [];
    const result = spawnSync(process.execPath, [cli, ...args, ...harnessRootArgs], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SKIT_HOME: authorHome,
        SKIT_SERVER_URL: registryUrl.origin,
        SKIT_TOKEN: cliToken,
      },
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    expect(
      result.status,
      [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"),
    ).toBe(expectedStatus);
    return result;
  }

  let registryUrl: URL;
  try {
    registryUrl = (await server.listen()).url;
    expect(["127.0.0.1", "localhost", "::1"]).toContain(registryUrl.hostname);
    await server.update({
      root: serverRoot,
      workers: [
        {
          configPath: "./test/wrangler.test.jsonc",
          vars: { PUBLIC_APP_ORIGIN: registryUrl.origin, ACCOUNT_REGISTRATION_MODE: "closed" },
          secrets: {
            BETTER_AUTH_SECRET: "skit-e2e-secret-that-is-at-least-thirty-two-characters",
            SKIT_BOOTSTRAP_SECRET:
              "skit-e2e-bootstrap-secret-that-is-at-least-thirty-two-characters",
          },
        },
      ],
    });
    const worker = server.getWorker<RuntimeEnv>();
    await worker.applyD1Migrations("DB");

    const health = await fetch(new URL("/health", registryUrl));
    expect(health.status).toBe(200);
    const bootstrap = await fetch(new URL("/api/bootstrap", registryUrl), {
      method: "POST",
      headers: {
        "cf-connecting-ip": "192.0.2.100",
        "content-type": "application/json",
        origin: registryUrl.origin,
      },
      body: JSON.stringify({
        token: "skit-e2e-bootstrap-secret-that-is-at-least-thirty-two-characters",
        username: "lifecycle-author",
        email: "lifecycle-author@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(201);
    const closedRegistration = await fetch(new URL("/api/auth/sign-up/email", registryUrl), {
      method: "POST",
      headers: {
        "cf-connecting-ip": "192.0.2.102",
        "content-type": "application/json",
        origin: registryUrl.origin,
      },
      body: JSON.stringify({
        name: "Unexpected Registrant",
        email: "unexpected@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(closedRegistration.status).toBeGreaterThanOrEqual(400);
    const signIn = await fetch(new URL("/api/auth/sign-in/email", registryUrl), {
      method: "POST",
      headers: {
        "cf-connecting-ip": "192.0.2.101",
        "content-type": "application/json",
        origin: registryUrl.origin,
      },
      body: JSON.stringify({
        email: "lifecycle-author@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(cookie).toContain("skit-auth.session_token=");
    const readiness = await fetch(new URL("/api/operator/readiness", registryUrl), {
      headers: { cookie },
    });
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toMatchObject({
      schema: "skit.server.readiness.v1",
      ready: true,
    });
    const missingCredential = spawnSync(process.execPath, [deploymentVerifier], {
      encoding: "utf8",
      env: { ...process.env, SKIT_SERVER_URL: registryUrl.origin, SKIT_SESSION_COOKIE: "" },
    });
    expect(missingCredential.status).toBe(2);
    expect(missingCredential.stderr).toContain("SKIT_SESSION_COOKIE is required");
    const verified = spawnSync(process.execPath, [deploymentVerifier], {
      encoding: "utf8",
      env: {
        ...process.env,
        SKIT_SERVER_URL: registryUrl.origin,
        SKIT_SESSION_COOKIE: cookie,
      },
    });
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("Liveness: ok");
    expect(verified.stdout).toContain("PASS bootstrap: Initial operator exists");

    const createdToken = await fetch(new URL("/api/tokens", registryUrl), {
      method: "POST",
      headers: { cookie, origin: registryUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({
        name: "E2E lifecycle",
        scopes: ["library:sync", "authoring:write", "publication:write"],
      }),
    });
    expect(createdToken.status).toBe(201);
    const issued = Schema.decodeUnknownSync(
      Schema.Struct({
        token_id: Schema.String,
        token: Schema.String,
        token_prefix: Schema.String,
        scopes: Schema.Array(Schema.String),
      }),
    )(await createdToken.json());
    expect(issued).toMatchObject({
      token_prefix: expect.stringMatching(/^skit_pat_/),
      scopes: ["library:sync", "authoring:write", "publication:write"],
    });
    cliToken = issued.token;

    const initialized = JSON.parse(skit(["author", "init", authorSource, "--json"]).stdout);
    expect(initialized).toMatchObject({
      schema: "skit.init.v1",
      data: { path: authorSource },
    });
    await cp(
      join(fixtures, "author", "SKILL.md"),
      join(authorSource, "skills", "author-lifecycle", "SKILL.md"),
    );
    const drifted = JSON.parse(skit(["author", "validate", authorSource, "--json"]).stdout);
    expect(drifted).toMatchObject({
      schema: "skit.validate.v3",
      data: {
        valid: true,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "INVOCATION_METADATA_MISMATCH", severity: "warning" }),
        ]),
      },
    });
    const baked = JSON.parse(skit(["author", "invocation", authorSource, "--json"]).stdout);
    expect(baked).toMatchObject({
      schema: "skit.author.invocation.v1",
      data: {
        generated: [
          {
            skill: "author-lifecycle",
            harness: "claude-code",
            path: "skills/author-lifecycle/SKILL.md",
            policy: "explicit",
            changed: true,
          },
          {
            skill: "author-lifecycle",
            harness: "codex",
            path: "skills/author-lifecycle/agents/openai.yaml",
            policy: "explicit",
            // The scaffold is born conforming, so only the replaced SKILL.md needed rewriting.
            changed: false,
          },
        ],
      },
    });
    const validated = JSON.parse(skit(["author", "validate", authorSource, "--json"]).stdout);
    expect(validated).toMatchObject({
      schema: "skit.validate.v3",
      data: { valid: true, diagnostics: [] },
    });
    const createdDraft = JSON.parse(
      skit([
        "author",
        "sync",
        authorSource,
        "--to",
        "lifecycle-author/author-lifecycle",
        "--visibility",
        "private",
        "--apply",
        "--home",
        authorHome,
        "--json",
      ]).stdout,
    );
    expect(createdDraft).toMatchObject({
      schema: "skit.author.sync.v2",
      data: { status: "created", changed: true, revision_id: expect.any(String) },
    });
    skit(["author", "publish", authorSource, "--version", "1.0.0"]);
    const consumed = JSON.parse(
      skit([
        "add",
        "lifecycle-author/author-lifecycle",
        "--version",
        "1.0.0",
        "--home",
        consumerHome,
        "--json",
      ]).stdout,
    );
    expect(consumed).toMatchObject({
      schema: "skit.add.v3",
      data: {
        collection_id: expect.any(String),
        retained_version_id: expect.any(String),
        snapshot_digest: expect.stringMatching(/^sha256:/),
        skills: [{ name: "author-lifecycle" }],
      },
    });
    skit(["enable", "author-lifecycle", "--for", "codex", "--home", consumerHome]);
    expect(await readFile(join(roots.codex, "author-lifecycle", "SKILL.md"), "utf8")).toContain(
      "Published from the generated scaffold.",
    );

    const draftUrl = new URL("/api/skits/lifecycle-author/author-lifecycle/draft", registryUrl);
    const remoteDraftResponse = await fetch(draftUrl, {
      headers: { authorization: `Bearer ${cliToken}` },
    });
    expect(remoteDraftResponse.status).toBe(200);
    const remoteDraft = Schema.decodeUnknownSync(DraftReadResponse)(
      await remoteDraftResponse.json(),
    );
    const remoteFiles = remoteDraft.draft.files.map((file) =>
      file.path === "README.md"
        ? {
            ...file,
            content_base64: Buffer.from(
              `${Buffer.from(file.content_base64, "base64").toString("utf8")}\nEdited remotely.\n`,
            ).toString("base64"),
          }
        : file,
    );
    const remoteUpdate = await fetch(draftUrl, {
      method: "PUT",
      headers: { authorization: `Bearer ${cliToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: remoteDraft.draft.title,
        description: remoteDraft.draft.description,
        visibility: remoteDraft.draft.visibility,
        descriptor: remoteDraft.draft.descriptor,
        diagnostics: remoteDraft.draft.diagnostics,
        expected_revision_id: remoteDraft.draft.revision_id,
        files: remoteFiles,
      }),
    });
    expect(remoteUpdate.status).toBe(200);
    await cp(
      join(fixtures, "author-local-edit", "SKILL.md"),
      join(authorSource, "skills", "author-lifecycle", "SKILL.md"),
    );
    const preview = JSON.parse(
      skit(["author", "sync", authorSource, "--home", authorHome, "--json"]).stdout,
    );
    expect(preview).toMatchObject({
      schema: "skit.author.sync.v2",
      data: {
        status: "merge_ready",
        changed: false,
        paths: ["README.md", "skills/author-lifecycle/SKILL.md"],
      },
    });
    const merged = JSON.parse(
      skit(["author", "sync", authorSource, "--home", authorHome, "--apply", "--json"]).stdout,
    );
    expect(merged).toMatchObject({
      schema: "skit.author.sync.v2",
      data: { status: "merged", changed: true, revision_id: expect.any(String) },
    });
    expect(await readFile(join(authorSource, "README.md"), "utf8")).toContain("Edited remotely.");
    const staleUpdate = await fetch(draftUrl, {
      method: "PUT",
      headers: { authorization: `Bearer ${cliToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: remoteDraft.draft.title,
        description: remoteDraft.draft.description,
        visibility: remoteDraft.draft.visibility,
        descriptor: remoteDraft.draft.descriptor,
        expected_revision_id: remoteDraft.draft.revision_id,
        files: remoteDraft.draft.files,
      }),
    });
    expect(staleUpdate.status, await staleUpdate.clone().text()).toBe(409);

    skit(["disable", "author-lifecycle", "--for", "codex", "--home", consumerHome]);
    expect(existsSync(join(roots.codex, "author-lifecycle"))).toBe(false);

    const deleteIdentity = `skit://${registryUrl.host}/lifecycle-author/author-lifecycle`;
    const deleteTarget = new URL("/lifecycle-author/author-lifecycle", registryUrl).toString();
    expect(
      JSON.parse(skit(["author", "delete", deleteTarget, "--dry-run", "--json"]).stdout),
    ).toMatchObject({
      schema: "skit.author.delete.v1",
      data: {
        status: "delete_ready",
        changed: false,
        draft_revisions: 3,
        release_versions: ["1.0.0"],
      },
    });
    expect(JSON.parse(skit(["author", "delete", deleteTarget, "--json"]).stdout)).toMatchObject({
      schema: "skit.author.delete.v1",
      data: { status: "deleted", changed: true, archive_cleanup: "complete" },
    });
    expect(
      (
        await fetch(
          new URL(
            "/api/skits/lifecycle-author/author-lifecycle/releases/1.0.0/download",
            registryUrl,
          ),
          { headers: { authorization: `Bearer ${cliToken}` } },
        )
      ).status,
    ).toBe(404);
    const authoredAfterDelete = JSON.parse(skit(["author", "list", "--json"]).stdout);
    expect(
      authoredAfterDelete.data.skits.map((item: { identity: string }) => item.identity),
    ).not.toContain(deleteIdentity);
    expect(JSON.parse(skit(["author", "delete", deleteTarget, "--json"]).stdout)).toMatchObject({
      data: { status: "absent", changed: false },
    });

    const revoked = await fetch(new URL(`/api/tokens/${issued.token_id}`, registryUrl), {
      method: "DELETE",
      headers: { cookie, origin: registryUrl.origin },
    });
    expect(revoked.status).toBe(204);
    expect(
      (
        await fetch(new URL("/api/library", registryUrl), {
          headers: { authorization: `Bearer ${cliToken}` },
        })
      ).status,
    ).toBe(401);
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
    if (keepWorkspace) console.error(`Retained E2E workspace for inspection at ${workspace}`);
    else await rm(workspace, { recursive: true, force: true });
  }
});

test("restores an unbound raw Skill and reconciles two portable Library homes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "skit-portable-e2e-"));
  const keepWorkspace = process.env.SKIT_E2E_KEEP === "1";
  const raw = join(workspace, "raw-review");
  const gitRepository = join(workspace, "git-repository");
  const gitShimDirectory = join(workspace, "git-shim");
  const gitRemote = "https://example.invalid/portable-skills.git";
  const firstHome = join(workspace, "first-library");
  const secondHome = join(workspace, "second-library");
  const firstDevice = join(workspace, "first-device");
  const secondDevice = join(workspace, "second-device");
  const firstCodex = join(workspace, "first-codex", "skills");
  const firstClaude = join(workspace, "first-claude", "skills");
  const secondCodex = join(workspace, "second-codex", "skills");
  const secondClaude = join(workspace, "second-claude", "skills");
  const rawText =
    "---\nname: raw-review\ndescription: Private raw Skill.\n---\n\n# Raw review\n\nobserved bytes\n";
  const server = createTestHarness({
    root: serverRoot,
    workers: [
      {
        configPath: "./test/wrangler.test.jsonc",
        secrets: {
          BETTER_AUTH_SECRET: "skit-portable-e2e-secret-that-is-long-enough",
          SKIT_BOOTSTRAP_SECRET: "skit-portable-e2e-bootstrap-secret-that-is-long-enough",
        },
      },
    ],
  });
  let registryUrl: URL;
  let token: string;
  const run = (
    args: string[],
    home: string,
    device: string,
    roots: { codex: string; claude: string },
    expectedStatus = 0,
  ) => {
    const rootArgs =
      args[0] === "library" ? [] : ["--codex-root", roots.codex, "--claude-root", roots.claude];
    const processResult = spawnSync(
      process.execPath,
      [cli, ...args, "--home", home, ...rootArgs, "--json"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: device,
          PATH: `${gitShimDirectory}:${process.env.PATH}`,
          SKIT_SERVER_URL: registryUrl.origin,
          SKIT_TOKEN: token,
        },
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    expect(
      processResult.status,
      [processResult.error?.message, processResult.stdout, processResult.stderr]
        .filter(Boolean)
        .join("\n"),
    ).toBe(expectedStatus);
    return Schema.decodeUnknownSync(
      Schema.Struct({
        schema: Schema.String,
        data: Schema.Unknown,
      }),
    )(JSON.parse(processResult.stdout || processResult.stderr));
  };
  const first = (args: string[], expectedStatus = 0) =>
    run(args, firstHome, firstDevice, { codex: firstCodex, claude: firstClaude }, expectedStatus);
  const second = (args: string[], expectedStatus = 0) =>
    run(
      args,
      secondHome,
      secondDevice,
      { codex: secondCodex, claude: secondClaude },
      expectedStatus,
    );
  const state = async (home: string) =>
    Schema.decodeUnknownSync(
      Schema.Struct({
        schemaVersion: Schema.Number,
        collections: Schema.Array(
          Schema.Struct({
            collection_id: Schema.String,
          }),
        ),
        retained_copies: Schema.Array(
          Schema.Struct({ retained_copy_id: Schema.String, digest: Schema.String }),
        ),
        acquisitions: Schema.Array(
          Schema.Struct({
            retained_copy_id: Schema.String,
            observations: Schema.Array(Schema.Unknown),
            selection: Schema.Union([
              Schema.Struct({ kind: Schema.Literal("full-tree") }),
              Schema.Struct({
                kind: Schema.Literal("selected-paths"),
                paths: Schema.Array(Schema.String),
              }),
            ]),
            source_revision: Schema.optionalKey(Schema.String),
          }),
        ),
        global_bindings: Schema.Array(
          Schema.Struct({
            collection_id: Schema.String,
            harness: Schema.String,
            skills: Schema.Array(Schema.String),
          }),
        ),
        local_bindings: Schema.Array(Schema.Unknown),
      }),
    )(JSON.parse(await readFile(join(home, "state.json"), "utf8")));
  try {
    await mkdir(raw, { recursive: true });
    await writeFile(join(raw, "SKILL.md"), rawText);
    await mkdir(join(gitRepository, "skills", "git-review"), { recursive: true });
    await writeFile(
      join(gitRepository, "skills", "git-review", "SKILL.md"),
      "---\nname: git-review\ndescription: Git-backed review Skill.\n---\n\n# Git review\n",
    );
    await symlink("../../.claude/skills/outside", join(gitRepository, "outside-skill"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: gitRepository, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
    const gitRevision = git("rev-parse", "HEAD");
    await mkdir(gitShimDirectory);
    const gitShim = join(gitShimDirectory, "git");
    await writeFile(
      gitShim,
      `#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst args = process.argv.slice(2).map((value) => value === ${JSON.stringify(gitRemote)} ? ${JSON.stringify(gitRepository)} : value);\nconst result = spawnSync("/usr/bin/git", args, { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
    );
    await chmod(gitShim, 0o755);
    registryUrl = (await server.listen()).url;
    await server.update({
      root: serverRoot,
      workers: [
        {
          configPath: "./test/wrangler.test.jsonc",
          vars: { PUBLIC_APP_ORIGIN: registryUrl.origin, ACCOUNT_REGISTRATION_MODE: "closed" },
          secrets: {
            BETTER_AUTH_SECRET: "skit-portable-e2e-secret-that-is-long-enough",
            SKIT_BOOTSTRAP_SECRET: "skit-portable-e2e-bootstrap-secret-that-is-long-enough",
          },
        },
      ],
    });
    const worker = server.getWorker<RuntimeEnv>();
    await worker.applyD1Migrations("DB");
    const bootstrap = await fetch(new URL("/api/bootstrap", registryUrl), {
      method: "POST",
      headers: {
        "cf-connecting-ip": "192.0.2.110",
        "content-type": "application/json",
        origin: registryUrl.origin,
      },
      body: JSON.stringify({
        token: "skit-portable-e2e-bootstrap-secret-that-is-long-enough",
        username: "portable-author",
        email: "portable-author@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(201);
    const signedIn = await fetch(new URL("/api/auth/sign-in/email", registryUrl), {
      method: "POST",
      headers: {
        "cf-connecting-ip": "192.0.2.111",
        "content-type": "application/json",
        origin: registryUrl.origin,
      },
      body: JSON.stringify({
        email: "portable-author@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const readiness = await fetch(new URL("/api/operator/readiness", registryUrl), {
      headers: { cookie },
    });
    expect(readiness.status, await readiness.clone().text()).toBe(200);
    expect(await readiness.json()).toMatchObject({
      schema: "skit.server.readiness.v1",
      ready: true,
      checks: expect.arrayContaining([
        {
          name: "migrations",
          status: "ok",
          detail: `Applied ${expectedMigrations.length} expected migrations`,
        },
      ]),
    });
    const createdToken = await fetch(new URL("/api/tokens", registryUrl), {
      method: "POST",
      headers: { cookie, origin: registryUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "Library E2E", scopes: ["library:sync"] }),
    });
    expect(createdToken.status, await createdToken.clone().text()).toBe(201);
    token = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(
      await createdToken.json(),
    ).token;

    first(["add", raw]);
    first(["add", gitRemote]);
    const retained = await state(firstHome);
    expect(retained.schemaVersion).toBe(4);
    expect(retained.collections).toHaveLength(2);
    expect(retained.global_bindings).toEqual([]);
    const collectionId = retained.collections[0].collection_id;
    const selected = retained.retained_copies[0];
    expect(selected).toBeDefined();
    const selectedHex = selected!.digest.slice("sha256:".length);
    const selectedPath = join(firstHome, "originals", selectedHex.slice(0, 2), selectedHex);
    expect(await readFile(join(selectedPath, "SKILL.md"), "utf8")).toBe(rawText);
    expect(existsSync(join(selectedPath, "README.md"))).toBe(false);
    expect(first(["sync", "--apply"])).toMatchObject({
      data: { status: "pushed", snapshots: 1 },
    });
    const remoteRead = await fetch(new URL("/api/library/portable", registryUrl), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(remoteRead.status, await remoteRead.clone().text()).toBe(200);
    const remote = Schema.decodeUnknownSync(
      Schema.Struct({
        library: Schema.Struct({
          revision_id: Schema.String,
          manifest: Schema.Struct({
            schema: Schema.String,
            collections: Schema.Array(Schema.Struct({ collection_id: Schema.String })),
            snapshot_digests: Schema.Array(Schema.String),
            bindings: Schema.Array(Schema.Unknown),
          }),
        }),
      }),
    )(await remoteRead.json());
    expect(remote.library.manifest).toMatchObject({
      schema: "skit.library.v5",
      snapshot_digests: [selected!.digest],
      bindings: [],
    });
    expect(remote.library.manifest.collections).toHaveLength(2);
    expect(
      remote.library.manifest.collections.some((item) => item.collection_id === collectionId),
    ).toBe(true);
    expect(second(["sync"])).toMatchObject({ data: { status: "pull_ready" } });
    expect(second(["sync", "--apply"])).toMatchObject({ data: { status: "pulled" } });
    const restored = await state(secondHome);
    expect(restored.schemaVersion).toBe(4);
    expect(restored.collections.some((item) => item.collection_id === collectionId)).toBe(true);
    expect(restored.acquisitions[0].observations).toEqual([]);
    expect(restored.global_bindings).toEqual([]);
    const restoredHex = restored.retained_copies[0].digest.slice("sha256:".length);
    const restoredPath = join(secondHome, "originals", restoredHex.slice(0, 2), restoredHex);
    expect(await readFile(join(restoredPath, "SKILL.md"), "utf8")).toBe(rawText);
    expect(existsSync(join(restoredPath, "README.md"))).toBe(false);
    const gitAcquisition = restored.acquisitions.find(
      (item) => item.selection.kind === "selected-paths",
    );
    expect(gitAcquisition).toMatchObject({
      selection: { kind: "selected-paths", paths: ["skills/git-review"] },
      source_revision: gitRevision,
    });
    const gitCopy = restored.retained_copies.find(
      (item) => item.retained_copy_id === gitAcquisition?.retained_copy_id,
    );
    expect(gitCopy).toBeDefined();
    const gitHex = gitCopy!.digest.slice("sha256:".length);
    const gitOriginal = join(secondHome, "originals", gitHex.slice(0, 2), gitHex);
    expect(await readFile(join(gitOriginal, "skills", "git-review", "SKILL.md"), "utf8")).toContain(
      "# Git review",
    );
    expect(existsSync(join(gitOriginal, "outside-skill"))).toBe(false);
    expect(second(["sync", "--apply"])).toMatchObject({ data: { status: "clean" } });

    first(["enable", collectionId, "--all", "--for", "codex"]);
    second(["enable", collectionId, "--all", "--for", "claude"]);
    expect(first(["sync", "--apply"])).toMatchObject({ data: { status: "merged" } });
    expect(second(["sync"])).toMatchObject({ data: { status: "merge_ready" } });
    expect(second(["sync", "--apply"])).toMatchObject({ data: { status: "merged" } });
    const converged = await state(secondHome);
    expect(converged.global_bindings.map((binding) => binding.harness).sort()).toEqual(
      ["claude-code", "codex"].sort(),
    );
    expect(await readFile(join(secondCodex, "raw-review", "SKILL.md"), "utf8")).toBe(rawText);
    expect(await readFile(join(secondClaude, "raw-review", "SKILL.md"), "utf8")).toBe(rawText);
    expect(second(["sync", "--apply"])).toMatchObject({ data: { status: "clean" } });
    expect(first(["sync", "--apply"])).toMatchObject({ data: { status: "merged" } });
    expect(first(["remove", collectionId])).toMatchObject({
      data: { collection_id: collectionId },
    });
    expect(first(["sync", "--apply"])).toMatchObject({ data: { status: "merged" } });
    expect(second(["sync"])).toMatchObject({
      data: { status: "merge_ready", collections_to_remove: 1 },
    });
    expect(second(["sync", "--apply"])).toMatchObject({
      data: { status: "merged", retired: 2 },
    });
    expect(existsSync(join(secondCodex, "raw-review"))).toBe(false);
    expect(existsSync(join(secondClaude, "raw-review"))).toBe(false);
    expect((await state(secondHome)).collections).toHaveLength(1);
    expect(second(["sync", "--apply"])).toMatchObject({ data: { status: "clean" } });
  } finally {
    await server.close();
    if (keepWorkspace) console.error(`Retained portable E2E workspace at ${workspace}`);
    else await rm(workspace, { recursive: true, force: true });
  }
});
