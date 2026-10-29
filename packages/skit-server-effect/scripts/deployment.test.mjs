import { existsSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { buildEnvironment } from "./build.mjs";
import {
  bootstrapCommand,
  bucketLookup,
  cloudflareAuthHeaders,
  configurationMigration,
  deploy,
  deployTargets,
  DeploymentInputError,
  environmentConfiguration,
  exampleConfiguration,
  findDatabaseCollision,
  initialConfiguration,
  parseCanonicalOrigin,
  parseDeploymentConfiguration,
  parseEnvironment,
  parseSetupOptions,
  promoteToCustomDomain,
  selectAccount,
  shellCommand,
  setupPlan,
  withBucketBinding,
  withDatabaseBinding,
  withEmailSending,
  withEnvironmentDatabaseId,
  withApplicationHosting,
  withRateLimiters,
  workersDevOrigin,
} from "./deployment.mjs";

describe("server deployment configuration", () => {
  it("keeps the committed example aligned with generated deployment configuration", async () => {
    const source = await readFile(new URL("../wrangler.example.jsonc", import.meta.url), "utf8");
    assert.deepEqual(parseDeploymentConfiguration(source), exampleConfiguration());
  });

  it("selects a safe local configuration migration", () => {
    assert.equal(configurationMigration(false, false), "missing");
    assert.equal(configurationMigration(true, false), "current");
    assert.equal(configurationMigration(false, true), "migrate");
    assert.equal(configurationMigration(true, true), "conflict");
  });

  it("uses one Foldkit build identity for every Vite environment", () => {
    assert.equal(buildEnvironment({}, () => "generated").FOLDKIT_BUILD_ID, "generated");
    assert.equal(
      buildEnvironment({ FOLDKIT_BUILD_ID: "deployment" }, () => "unused").FOLDKIT_BUILD_ID,
      "deployment",
    );
  });

  it("reads Wrangler JSONC comments and trailing commas", () => {
    assert.deepEqual(
      parseDeploymentConfiguration(`{
        // Wrangler configuration
        "name": "skit-server",
        "routes": ["skit.example/*",],
      }`),
      { name: "skit-server", routes: ["skit.example/*"] },
    );
  });

  it("parses resource names without asking for the account subdomain", () => {
    const options = parseSetupOptions([
      "--name",
      "my-skit",
      "--account",
      "Example Account",
      "--database-name",
      "my-skit-database",
      "--bucket-name",
      "my-skit-bucket",
      "--email-from",
      "noreply@registry.example.com",
      "--dry-run",
    ]);
    assert.deepEqual(options, {
      workerName: "my-skit",
      databaseName: "my-skit-database",
      bucketName: "my-skit-bucket",
      account: "Example Account",
      emailFrom: "noreply@registry.example.com",
      dryRun: true,
    });
  });

  it("configures Cloudflare Email Service from one explicit sender address", () => {
    const configured = withEmailSending(
      initialConfiguration({ workerName: "skit-server" }),
      "noreply@registry.example.com",
    );
    assert.equal(configured.vars.EMAIL_FROM, "noreply@registry.example.com");
    assert.deepEqual(configured.send_email, [
      {
        name: "EMAIL",
        allowed_sender_addresses: ["noreply@registry.example.com"],
      },
    ]);
    assert.throws(
      () => withEmailSending(configured, "SKIT <noreply@registry.example.com>"),
      /bare email address/,
    );
  });

  it("rejects the obsolete workers.dev label and invalid worker names", () => {
    assert.throws(
      () => parseSetupOptions(["--workers-subdomain", "https://example.workers.dev"]),
      DeploymentInputError,
    );
    assert.throws(
      () => parseSetupOptions(["--workers-subdomain", "account", "--name", "Not Valid"]),
      DeploymentInputError,
    );
  });

  it("selects one Cloudflare account by ID or name and rejects ambiguity", () => {
    const accounts = [
      { id: "one", name: "First" },
      { id: "two", name: "Second" },
    ];
    assert.equal(selectAccount(accounts, "two"), accounts[1]);
    assert.equal(selectAccount(accounts, "First"), accounts[0]);
    assert.throws(() => selectAccount(accounts), /multiple Cloudflare accounts/);
    assert.equal(selectAccount([accounts[0]]), accounts[0]);
  });

  it("builds Cloudflare authentication headers without changing the credential", () => {
    assert.deepEqual(cloudflareAuthHeaders({ type: "oauth", token: "secret" }), {
      Authorization: "Bearer secret",
    });
    assert.deepEqual(
      cloudflareAuthHeaders({ type: "api_key", key: "secret", email: "me@example.com" }),
      { "X-Auth-Key": "secret", "X-Auth-Email": "me@example.com" },
    );
  });

  it("derives the canonical origin from Cloudflare's account subdomain", () => {
    assert.equal(
      workersDevOrigin("my-skit", "example-account"),
      "https://my-skit.example-account.workers.dev",
    );
  });

  it("plans provisioning, build, migration, then deployment", () => {
    const plan = setupPlan({
      workerName: "skit-server",
      databaseName: "skit-server-db",
      bucketName: "skit-server-blobs",
    });
    assert.deepEqual(
      plan.commands.map((command) => command.slice(0, 3)),
      [
        ["wrangler", "d1", "create"],
        ["wrangler", "r2", "bucket"],
        ["pnpm", "build"],
        ["wrangler", "d1", "migrations"],
        ["wrangler", "deploy", "--secrets-file"],
      ],
    );
    assert.equal(plan.databaseName, "skit-server-db");
    assert.equal(plan.bucketName, "skit-server-blobs");
  });

  it("upgrades an existing deployment config for unified SSR hosting", () => {
    const configuration = withApplicationHosting({
      name: "skit-server",
      compatibility_flags: ["streams_enable_constructors"],
      assets: { directory: "../old-web/dist" },
    });
    assert.deepEqual(configuration.compatibility_flags, [
      "streams_enable_constructors",
      "nodejs_compat",
    ]);
    assert.equal(configuration.assets.binding, "ASSETS");
    assert.equal(configuration.assets.directory, "web/dist/client");
    assert.deepEqual(configuration.assets.run_worker_first.slice(0, 3), ["/", "/setup", "/device"]);
  });

  it("adds the rate limiters a Worker lacks without changing the ones it declares", () => {
    const configuration = withApplicationHosting({
      name: "skit-server",
      ratelimits: [
        { name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } },
        { name: "PAT_RATE_LIMITER", namespace_id: "1002", simple: { limit: 5, period: 60 } },
        { name: "BOOTSTRAP_RATE_LIMITER", namespace_id: "1003", simple: { limit: 5, period: 60 } },
      ],
      env: { test: { ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "2001" }] } },
    });
    assert.deepEqual(configuration.ratelimits.slice(0, 1), [
      { name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } },
    ]);
    assert.deepEqual(configuration.ratelimits.at(-1), {
      name: "FEEDBACK_RATE_LIMITER",
      namespace_id: "1004",
      simple: { limit: 5, period: 60 },
    });
    assert.deepEqual(
      configuration.env.test.ratelimits.map(({ name, namespace_id }) => [name, namespace_id]),
      [
        ["AUTH_RATE_LIMITER", "2001"],
        ["PAT_RATE_LIMITER", "2002"],
        ["BOOTSTRAP_RATE_LIMITER", "2003"],
        ["FEEDBACK_RATE_LIMITER", "2004"],
      ],
    );
  });

  it("reads targets from Wrangler's versioned structured deployment output", () => {
    const output = [
      JSON.stringify({ type: "wrangler-session", version: 1 }),
      JSON.stringify({
        type: "deploy",
        version: 1,
        targets: ["https://skit-server.example.workers.dev"],
      }),
    ].join("\n");
    assert.deepEqual(deployTargets(output), ["https://skit-server.example.workers.dev"]);
  });

  it("hands bootstrap the generated config and package-local Wrangler", () => {
    assert.deepEqual(
      bootstrapCommand("https://skit-server.example.workers.dev", {
        configPath: "/repo/server/wrangler.jsonc",
        wranglerPath: "/repo/server/node_modules/.bin/wrangler",
      }),
      [
        "pnpm",
        "skit",
        "server",
        "bootstrap",
        "--url",
        "https://skit-server.example.workers.dev",
        "--config",
        "/repo/server/wrangler.jsonc",
        "--wrangler",
        "/repo/server/node_modules/.bin/wrangler",
      ],
    );
  });

  it("hands bootstrap the Wrangler environment it must target", () => {
    assert.deepEqual(
      bootstrapCommand(
        "https://skit-test.example.com",
        { configPath: "/repo/server/wrangler.jsonc", wranglerPath: "/repo/wrangler" },
        "test",
      ),
      [
        "pnpm",
        "skit",
        "server",
        "bootstrap",
        "--url",
        "https://skit-test.example.com",
        "--config",
        "/repo/server/wrangler.jsonc",
        "--env",
        "test",
        "--wrangler",
        "/repo/wrangler",
      ],
    );
  });

  it("reads one declared Wrangler environment and rejects undeclared or malformed names", () => {
    const configuration = { name: "skit-server", env: { test: { vars: { A: "1" } } } };
    assert.equal(parseEnvironment(["--env", "test"]), "test");
    assert.equal(parseEnvironment([]), undefined);
    assert.throws(() => parseEnvironment(["--env", "Test_1"]), DeploymentInputError);
    assert.throws(() => parseEnvironment(["--env"]), DeploymentInputError);
    assert.deepEqual(environmentConfiguration(configuration, "test"), { vars: { A: "1" } });
    assert.throws(() => environmentConfiguration(configuration, "staging"), /no env\.staging/);
  });

  it("records an environment's D1 ID without touching the top level or other bindings", () => {
    const configuration = {
      name: "skit-server",
      d1_databases: [{ binding: "DB", database_name: "prod", database_id: "prod-id" }],
      env: {
        test: {
          vars: { PUBLIC_APP_ORIGIN: "https://skit-test.example.com" },
          d1_databases: [
            { binding: "DB", database_name: "skit-server-test", migrations_dir: "migrations" },
            { binding: "OTHER", database_name: "other" },
          ],
        },
      },
    };
    assert.deepEqual(withEnvironmentDatabaseId(configuration, "test", "test-id"), {
      ...configuration,
      env: {
        test: {
          ...configuration.env.test,
          d1_databases: [
            {
              binding: "DB",
              database_name: "skit-server-test",
              migrations_dir: "migrations",
              database_id: "test-id",
            },
            { binding: "OTHER", database_name: "other" },
          ],
        },
      },
    });
  });

  it("prints a directly copyable bootstrap command", () => {
    assert.equal(
      shellCommand(
        bootstrapCommand("https://skit-server.example.workers.dev", {
          configPath: "/repo/server/wrangler.jsonc",
          wranglerPath: "/repo/server/node_modules/.bin/wrangler",
        }),
      ),
      "pnpm skit server bootstrap --url https://skit-server.example.workers.dev --config /repo/server/wrangler.jsonc --wrangler /repo/server/node_modules/.bin/wrangler",
    );
    assert.equal(shellCommand(["command", "Example's Account"]), "command 'Example'\\''s Account'");
  });

  it("detects exact D1 collisions without treating other names as matches", () => {
    const databases = [
      { name: "skit-server", uuid: "legacy" },
      { name: "skit-server-db", uuid: "current" },
    ];
    assert.deepEqual(findDatabaseCollision(databases, "skit-server-db"), databases[1]);
    assert.equal(findDatabaseCollision(databases, "skit-server-test-db"), undefined);
  });

  it("adopts existing exact-name resources without dropping configured bindings", () => {
    const withDatabase = withDatabaseBinding(
      { d1_databases: [{ binding: "OTHER", database_name: "other", database_id: "other-id" }] },
      "skit-server-db",
      "database-id",
    );
    assert.deepEqual(withDatabase.d1_databases[1], {
      binding: "DB",
      database_name: "skit-server-db",
      database_id: "database-id",
      migrations_dir: "migrations",
    });
    const withBucket = withBucketBinding(
      { r2_buckets: [{ binding: "OTHER", bucket_name: "other" }] },
      "skit-server-blobs",
    );
    assert.deepEqual(withBucket.r2_buckets[1], {
      binding: "SKIT_BLOBS",
      bucket_name: "skit-server-blobs",
    });
  });

  it("distinguishes an absent R2 bucket from lookup failures", () => {
    assert.equal(bucketLookup(0, "bucket metadata"), "exists");
    assert.equal(bucketLookup(1, "The specified bucket does not exist. [code: 10006]"), "absent");
    assert.equal(bucketLookup(1, "authentication failed"), "failed");
  });

  it("promotes one HTTPS custom domain and disables workers.dev", () => {
    const initial = initialConfiguration({
      workerName: "skit-server",
      publicOrigin: "https://skit-server.example.workers.dev",
    });
    const promoted = promoteToCustomDomain(initial, "https://registry.example.com");
    assert.equal(promoted.workers_dev, false);
    assert.deepEqual(promoted.routes, [{ pattern: "registry.example.com", custom_domain: true }]);
    assert.equal(promoted.vars.PUBLIC_APP_ORIGIN, "https://registry.example.com");
    assert.equal(promoted.vars.ACCOUNT_REGISTRATION_MODE, "closed");
  });

  it("rejects paths, insecure origins, and workers.dev aliases as custom domains", () => {
    for (const origin of [
      "http://registry.example.com",
      "https://registry.example.com/path",
      "https://skit.example.workers.dev",
    ]) {
      assert.throws(() => parseCanonicalOrigin(origin), DeploymentInputError);
    }
  });
});

describe("server deployment execution", () => {
  const configuration = withApplicationHosting({ name: "test-server" });
  const rejectWrite = async () => {
    throw new Error("Unexpected configuration write in deployment test");
  };
  const build = { kind: "release", version: "0.2.0", commit: "abc123", buildId: "build-1" };
  it("does not migrate or deploy when the build fails", async () => {
    const calls = [];
    await assert.rejects(
      deploy(
        {},
        {
          read: async () => configuration,
          write: rejectWrite,
          build: async () => {
            calls.push("build");
            throw new Error("build failed");
          },
          run: (args) => calls.push(args),
          log: (message) => calls.push(message),
        },
      ),
      /build failed/,
    );
    assert.deepEqual(calls, ["build"]);
  });
  it("builds before migration, deploys that artifact, and reports its identity", async () => {
    const calls = [];
    await deploy(
      {},
      {
        read: async () => ({ ...configuration, account_id: "account-1" }),
        write: rejectWrite,
        build: async () => {
          calls.push("build");
          return { configPath: "built-wrangler.json", build };
        },
        run: (args, options) => calls.push({ args, options }),
        log: (message) => calls.push(message),
      },
    );
    assert.equal(calls[0], "build");
    assert.deepEqual(calls[1].args, ["d1", "migrations", "apply", "DB", "--remote"]);
    // wrangler d1 ignores the configured account when the login reaches several.
    const env = { CLOUDFLARE_ACCOUNT_ID: "account-1" };
    assert.deepEqual(calls[1].options, { env });
    assert.deepEqual(calls[2], {
      args: ["deploy"],
      options: { configPath: "built-wrangler.json", env },
    });
    assert.match(calls[3], /0.2.0.*release.*abc123.*build-1/);
  });
  it("builds and migrates a Wrangler environment, then deploys the artifact built for it", async () => {
    const calls = [];
    await deploy(
      { environment: "test" },
      {
        read: async () => ({ ...configuration, env: { test: withRateLimiters({ vars: {} }) } }),
        write: rejectWrite,
        build: async (_configuration, environment) => {
          calls.push({ build: environment });
          return { configPath: "built-wrangler.json", build };
        },
        run: (args, options) => calls.push({ args, options }),
        log: () => {},
      },
    );
    assert.deepEqual(calls, [
      { build: "test" },
      {
        args: ["d1", "migrations", "apply", "DB", "--remote", "--env", "test"],
        options: { env: {} },
      },
      // The built config is already flattened to env.test, so deploy takes no --env.
      { args: ["deploy"], options: { configPath: "built-wrangler.json", env: {} } },
    ]);
  });

  it("refuses an undeclared environment before building anything", async () => {
    const calls = [];
    await assert.rejects(
      deploy(
        { environment: "staging" },
        {
          read: async () => configuration,
          write: rejectWrite,
          build: async () => calls.push("build"),
          run: (args) => calls.push(args),
          log: () => {},
        },
      ),
      /no env\.staging/,
    );
    assert.deepEqual(calls, []);
  });

  it("does not deploy or announce success after migration failure", async () => {
    const calls = [];
    await assert.rejects(
      deploy(
        {},
        {
          read: async () => configuration,
          write: rejectWrite,
          build: async () => ({ configPath: "built-wrangler.json", build }),
          run: (args) => {
            calls.push(args);
            throw new Error("migration failed");
          },
          log: (message) => calls.push(message),
        },
      ),
      /migration failed/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "d1");
  });
  it("does not announce success for an unexpected setup target and removes temporary secrets", async () => {
    const calls = [];
    const messages = [];
    let secretFile;
    let outputFile;
    await assert.rejects(
      deploy(
        { installSecret: true, expectedOrigin: "https://expected.workers.dev" },
        {
          read: async () => configuration,
          write: rejectWrite,
          build: async () => ({ configPath: "built-wrangler.json", build }),
          run: (args, options) => {
            calls.push(args);
            if (args[0] === "deploy") {
              assert.equal(args[1], "--secrets-file");
              secretFile = args[2];
              assert.ok(existsSync(secretFile));
              outputFile = options.env.WRANGLER_OUTPUT_FILE_PATH;
              writeFileSync(
                outputFile,
                JSON.stringify({
                  type: "deploy",
                  version: 1,
                  targets: ["https://other.workers.dev"],
                }) + "\n",
              );
            }
          },
          log: (message) => messages.push(message),
        },
      ),
      /unexpected target/,
    );
    assert.equal(calls[0][0], "d1");
    assert.equal(calls[1][0], "deploy");
    assert.deepEqual(messages, []);
    assert.ok(secretFile);
    assert.equal(existsSync(secretFile), false);
    assert.equal(existsSync(outputFile), false);
  });
});
