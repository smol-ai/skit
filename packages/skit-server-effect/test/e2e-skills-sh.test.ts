import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { Schema } from "effect";
import { createTestHarness } from "wrangler";
import { expect, test } from "vitest";
import type { RuntimeEnv } from "../src/platform/cloudflare.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

const serverRoot = resolve(import.meta.dirname, "..");
const cli = join(repositoryRoot, "packages", "cli", "bin", "skit.js");
const fixtures = join(serverRoot, "test", "fixtures");

/**
 * The skills.sh CLI, resolved as an ordinary installed dependency. Nothing here downloads it: a
 * missing dependency has to fail the way any missing dependency fails, because a journey that
 * fetched its own tool would stop being the pinned, deterministic thing it exists to be.
 */
const skillsCli = join(repositoryRoot, "node_modules", "skills", "bin", "cli.mjs");
const skillsPackage = join(repositoryRoot, "node_modules", "skills", "package.json");

/** Directories the operator really uses, which this journey must leave exactly as it found them. */
const operatorRoots = [
  join(homedir(), ".claude", "skills"),
  join(homedir(), ".codex", "skills"),
  join(homedir(), ".agents", "skills"),
];

async function inventory(path: string): Promise<string[] | null> {
  try {
    return (await readdir(path, { recursive: true, withFileTypes: true }))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch {
    return null;
  }
}

test.skip("installs a published Release with the real skills.sh CLI and no SKIT", async () => {
  // Release consumption remains a v1 server capability, but this fixture currently seeds its
  // Releases through the removed `skit author` CLI. Re-enable the journey when release seeding no
  // longer depends on a command outside the v1 product.
  const workspace = await mkdtemp(join(tmpdir(), "skit-e2e-skills-sh-"));
  const source = join(workspace, "direct-install");
  const authorHome = join(workspace, "author-home");
  // Every root the third-party CLI can write to lives under the disposable workspace.
  const consumer = {
    home: join(workspace, "consumer-home"),
    project: join(workspace, "consumer-project"),
    claude: join(workspace, "consumer-claude"),
    codex: join(workspace, "consumer-codex"),
    xdgConfig: join(workspace, "consumer-xdg-config"),
    xdgState: join(workspace, "consumer-xdg-state"),
    xdgData: join(workspace, "consumer-xdg-data"),
    xdgCache: join(workspace, "consumer-xdg-cache"),
  };
  const keepWorkspace = process.env.SKIT_E2E_KEEP === "1";
  const operatorBefore = await Promise.all(operatorRoots.map(inventory));
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

  let registryUrl: URL;
  let cliToken = "";
  function skit(args: string[], expectedStatus = 0) {
    const result = spawnSync(process.execPath, [cli, ...args], {
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

  function skills(args: string[]) {
    const result = spawnSync(process.execPath, [skillsCli, ...args], {
      cwd: consumer.project,
      encoding: "utf8",
      // Only the configuration the CLI needs, with every writable location disposable.
      env: {
        PATH: process.env.PATH,
        HOME: consumer.home,
        USERPROFILE: consumer.home,
        XDG_CONFIG_HOME: consumer.xdgConfig,
        XDG_STATE_HOME: consumer.xdgState,
        XDG_DATA_HOME: consumer.xdgData,
        XDG_CACHE_HOME: consumer.xdgCache,
        CLAUDE_CONFIG_DIR: consumer.claude,
        CODEX_HOME: consumer.codex,
        DO_NOT_TRACK: "1",
        DISABLE_TELEMETRY: "1",
        CI: "1",
        NO_COLOR: "1",
      } as unknown as NodeJS.ProcessEnv,
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    expect(
      result.status,
      [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"),
    ).toBe(0);
    return result;
  }

  try {
    // The pinned dependency, not whatever `npx` would resolve today.
    const PackageVersion = Schema.Struct({ version: Schema.String });
    const RootPackage = Schema.Struct({
      devDependencies: Schema.Record(Schema.String, Schema.String),
    });
    const pinned = Schema.decodeUnknownSync(RootPackage)(
      JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")),
    );
    const installed = Schema.decodeUnknownSync(PackageVersion)(
      JSON.parse(await readFile(skillsPackage, "utf8")),
    );
    expect(installed.version).toBe(pinned.devDependencies.skills);

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
    const bootstrap = await fetch(new URL("/api/bootstrap", registryUrl), {
      method: "POST",
      headers: {
        "cf-connecting-ip": "192.0.2.110",
        "content-type": "application/json",
        origin: registryUrl.origin,
      },
      body: JSON.stringify({
        token: "skit-e2e-bootstrap-secret-that-is-at-least-thirty-two-characters",
        username: "direct-installer",
        email: "direct-installer@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(201);
    const signIn = await fetch(new URL("/api/auth/sign-in/email", registryUrl), {
      method: "POST",
      headers: {
        "cf-connecting-ip": "192.0.2.111",
        "content-type": "application/json",
        origin: registryUrl.origin,
      },
      body: JSON.stringify({
        email: "direct-installer@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const createdToken = await fetch(new URL("/api/tokens", registryUrl), {
      method: "POST",
      headers: { cookie, origin: registryUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Direct installation E2E",
        scopes: ["library:sync", "authoring:write", "publication:write"],
      }),
    });
    expect(createdToken.status).toBe(201);
    cliToken = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(
      await createdToken.json(),
    ).token;

    // SKIT publishes. From here on it takes no part in the consumption.
    await cp(join(fixtures, "direct-install"), source, { recursive: true });
    skit([
      "author",
      "sync",
      source,
      "--to",
      "direct-installer/direct-install",
      "--visibility",
      "public",
      "--apply",
    ]);
    skit(["author", "publish", source, "--version", "1.0.0"]);

    // A newer unlisted Release remains directly downloadable, but public discovery must neither
    // enumerate it nor let it replace the latest public Release.
    const hostSource = join(source, "skills", "direct-host", "SKILL.md");
    await writeFile(hostSource, `${await readFile(hostSource, "utf8")}\nUNLISTED_RELEASE_ONLY\n`);
    skit(["author", "sync", source, "--apply"]);
    skit(["author", "publish", source, "--version", "2.0.0"]);
    const env = await worker.getEnv();
    await env.DB.prepare(
      "UPDATE releases SET visibility = 'unlisted' WHERE owner_slug = ? AND skit_slug = ? AND version = ?",
    )
      .bind("direct-installer", "direct-install", "2.0.0")
      .run();

    // The discovery shape the skills.sh CLI reads, over plain HTTP on the loopback address.
    const indexUrl = new URL(
      "/direct-installer/direct-install/.well-known/agent-skills/index.json",
      registryUrl,
    );
    expect(indexUrl.protocol).toBe("http:");
    const index = await fetch(indexUrl);
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("public, no-cache");
    const AgentSkillsIndex = Schema.Struct({
      $schema: Schema.String,
      skills: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.String,
          type: Schema.Literal("archive"),
          url: Schema.String,
          digest: Schema.String,
        }),
      ),
    });
    const discovered = Schema.decodeUnknownSync(AgentSkillsIndex)(await index.json());
    expect(discovered).toEqual({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "direct-explicit",
          description: "Runs only when the operator names it, never on the model's initiative.",
          type: "archive",
          url: "/direct-installer/direct-install/skills/direct-explicit/skill.zip",
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        {
          name: "direct-host",
          description: "Leaves the decision to the Harness by declaring nothing about invocation.",
          type: "archive",
          url: "/direct-installer/direct-install/skills/direct-host/skill.zip",
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      ],
    });
    const artifact = await fetch(new URL(discovered.skills[0]!.url, registryUrl));
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("cache-control")).toBe("public, no-cache");

    await mkdir(consumer.project, { recursive: true });
    await writeFile(join(consumer.project, "package.json"), `${JSON.stringify({}, null, 2)}\n`);
    const installed3rdParty = skills([
      "add",
      `${registryUrl.origin}/direct-installer/direct-install`,
      "--skill",
      "*",
      "--agent",
      "claude-code",
      "codex",
      "--global",
      "--copy",
      "--yes",
    ]);
    // Proves it came through well-known discovery rather than the CLI's direct-download fallback.
    // It resolved the Registry through discovery, and the archive it pulled carried both files.
    expect(installed3rdParty.stdout).toContain(
      `Source: ${registryUrl.origin}/direct-installer/direct-install`,
    );
    expect(installed3rdParty.stdout).toContain("Files: SKILL.md, agents/openai.yaml");
    expect(installed3rdParty.stdout).toContain("direct-explicit");
    expect(installed3rdParty.stdout).toContain("direct-host");

    // Claude Code reads its own root; Codex reads the shared `.agents` root under the same HOME.
    const installRoots = [
      join(consumer.claude, "skills"),
      join(consumer.home, ".agents", "skills"),
    ];
    for (const root of installRoots) {
      const explicit = join(root, "direct-explicit");
      expect(await readFile(join(explicit, "SKILL.md"), "utf8")).toContain(
        "disable-model-invocation: true",
      );
      expect(await readFile(join(explicit, "agents", "openai.yaml"), "utf8")).toContain(
        "allow_implicit_invocation: false",
      );

      const host = join(root, "direct-host");
      const hostSkill = await readFile(join(host, "SKILL.md"), "utf8");
      expect(hostSkill).toContain("name: direct-host");
      expect(hostSkill).not.toContain("disable-model-invocation");
      expect(hostSkill).not.toContain("UNLISTED_RELEASE_ONLY");
      expect(existsSync(join(host, "agents", "openai.yaml"))).toBe(false);
    }

    for (const [index, root] of operatorRoots.entries())
      expect(await inventory(root), root).toEqual(operatorBefore[index]);
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
    if (keepWorkspace) console.error(`Retained E2E workspace for inspection at ${workspace}`);
    else await rm(workspace, { recursive: true, force: true });
  }
});
