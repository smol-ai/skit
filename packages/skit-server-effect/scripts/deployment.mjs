import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(packageRoot, "wrangler.jsonc");
const legacyConfigPath = join(packageRoot, "wrangler.deploy.jsonc");
const wranglerPath = join(packageRoot, "node_modules", ".bin", "wrangler");
const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const senderAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const workerFirstRoutes = [
  "/",
  "/setup",
  "/api/*",
  "/.well-known/*",
  "/health",
  "/*/*/.well-known/*",
  "/*/*/skills/*",
];

export class DeploymentInputError extends Error {}

export const parseDeploymentConfiguration = (source) => {
  const errors = [];
  const configuration = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0)
    throw new DeploymentInputError(
      `deployment configuration is invalid JSONC at offset ${errors[0].offset}`,
    );
  return configuration;
};

const valueAfter = (args, name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new DeploymentInputError(`${name} requires a value`);
  return value;
};

export const parseSetupOptions = (args) => {
  const workerName = valueAfter(args, "--name") ?? "skit-server";
  const databaseName = valueAfter(args, "--database-name") ?? `${workerName}-db`;
  const bucketName = valueAfter(args, "--bucket-name") ?? `${workerName}-blobs`;
  if (args.includes("--workers-subdomain"))
    throw new DeploymentInputError(
      "--workers-subdomain is no longer accepted; Wrangler discovers the deployed origin",
    );
  if (!workerNamePattern.test(workerName))
    throw new DeploymentInputError("--name must be a valid workers.dev DNS label");
  if (!workerNamePattern.test(databaseName))
    throw new DeploymentInputError("--database-name must use letters, numbers, and dashes");
  if (!workerNamePattern.test(bucketName))
    throw new DeploymentInputError("--bucket-name must use letters, numbers, and dashes");
  const emailFrom = valueAfter(args, "--email-from");
  if (emailFrom && !senderAddressPattern.test(emailFrom))
    throw new DeploymentInputError("--email-from must be one bare email address");
  return {
    workerName,
    databaseName,
    bucketName,
    account: valueAfter(args, "--account"),
    emailFrom,
    dryRun: args.includes("--dry-run"),
  };
};

export const selectAccount = (accounts, requested) => {
  if (!Array.isArray(accounts) || accounts.length === 0)
    throw new DeploymentInputError("Wrangler did not report any Cloudflare accounts");
  if (requested) {
    const account = accounts.find(({ id, name }) => id === requested || name === requested);
    if (!account) throw new DeploymentInputError(`Cloudflare account '${requested}' was not found`);
    return account;
  }
  if (accounts.length === 1) return accounts[0];
  throw new DeploymentInputError(
    `multiple Cloudflare accounts are available; select one with --account (${accounts
      .map(({ name }) => name)
      .join(", ")})`,
  );
};

export const cloudflareAuthHeaders = (credential) => {
  if (credential?.type === "api_key" && credential.key && credential.email)
    return { "X-Auth-Key": credential.key, "X-Auth-Email": credential.email };
  if ((credential?.type === "api_token" || credential?.type === "oauth") && credential.token)
    return { Authorization: `Bearer ${credential.token}` };
  throw new DeploymentInputError("Wrangler returned an unsupported authentication credential");
};

export const workersDevOrigin = (workerName, subdomain) => {
  if (!workerNamePattern.test(subdomain))
    throw new DeploymentInputError("Cloudflare returned an invalid workers.dev subdomain");
  return `https://${workerName}.${subdomain}.workers.dev`;
};

export const parseCanonicalOrigin = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DeploymentInputError("the custom-domain origin must be an absolute URL");
  }
  if (url.protocol !== "https:")
    throw new DeploymentInputError("the custom-domain origin must use HTTPS");
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash)
    throw new DeploymentInputError("provide only the custom-domain origin, without a path");
  if (url.hostname.endsWith(".workers.dev"))
    throw new DeploymentInputError("deploy:domain requires a custom domain, not workers.dev");
  return url.origin;
};

export const withApplicationHosting = (configuration) => ({
  ...configuration,
  compatibility_flags: Array.from(
    new Set([...(configuration.compatibility_flags ?? []), "nodejs_compat"]),
  ),
  assets: {
    ...configuration.assets,
    binding: "ASSETS",
    directory: "web/dist/client",
    not_found_handling: "single-page-application",
    run_worker_first: workerFirstRoutes,
  },
});

export const withEmailSending = (configuration, emailFrom) => {
  if (!senderAddressPattern.test(emailFrom))
    throw new DeploymentInputError("--email-from must be one bare email address");
  return {
    ...configuration,
    vars: { ...configuration.vars, EMAIL_FROM: emailFrom },
    send_email: [{ name: "EMAIL", allowed_sender_addresses: [emailFrom] }],
  };
};

export const initialConfiguration = ({ workerName, accountId, publicOrigin, emailFrom }) => {
  const configuration = withApplicationHosting({
    $schema: "node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "src/index.ts",
    compatibility_date: "2026-08-24",
    ...(accountId ? { account_id: accountId } : {}),
    workers_dev: true,
    vars: {
      ACCOUNT_REGISTRATION_MODE: "closed",
      ...(publicOrigin ? { PUBLIC_APP_ORIGIN: publicOrigin } : {}),
    },
    ratelimits: [
      {
        name: "AUTH_RATE_LIMITER",
        namespace_id: "1001",
        simple: { limit: 5, period: 60 },
      },
      {
        name: "PAT_RATE_LIMITER",
        namespace_id: "1002",
        simple: { limit: 5, period: 60 },
      },
      {
        name: "BOOTSTRAP_RATE_LIMITER",
        namespace_id: "1003",
        simple: { limit: 5, period: 60 },
      },
    ],
  });
  return emailFrom ? withEmailSending(configuration, emailFrom) : configuration;
};

export const exampleConfiguration = () => ({
  ...initialConfiguration({
    workerName: "skit-server",
    publicOrigin: "https://registry.example.com",
  }),
  d1_databases: [
    {
      binding: "DB",
      database_name: "skit-server-effect",
      database_id: "replace-with-cloudflare-d1-database-id",
      migrations_dir: "migrations",
    },
  ],
  r2_buckets: [{ binding: "SKIT_BLOBS", bucket_name: "skit-server-effect-blobs" }],
});

export const promoteToCustomDomain = (configuration, origin) => {
  const publicOrigin = parseCanonicalOrigin(origin);
  return {
    ...configuration,
    workers_dev: false,
    routes: [{ pattern: new URL(publicOrigin).hostname, custom_domain: true }],
    vars: {
      ...configuration.vars,
      ACCOUNT_REGISTRATION_MODE: "closed",
      PUBLIC_APP_ORIGIN: publicOrigin,
    },
  };
};

export const setupPlan = ({ databaseName, bucketName }) => ({
  databaseName,
  bucketName,
  commands: [
    ["wrangler", "d1", "create", databaseName, "--binding", "DB", "--update-config"],
    [
      "wrangler",
      "r2",
      "bucket",
      "create",
      bucketName,
      "--binding",
      "SKIT_BLOBS",
      "--update-config",
    ],
    ["wrangler", "d1", "migrations", "apply", "DB", "--remote"],
    ["pnpm", "build"],
    ["wrangler", "deploy", "--secrets-file", "<temporary-secret-file>"],
  ],
});

export const deployTargets = (output) => {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.type === "deploy" && entry.version === 1 && Array.isArray(entry.targets))
      return entry.targets;
  }
  throw new Error("Wrangler did not write a deployment result");
};

export const bootstrapCommand = (publicOrigin, paths = {}) => [
  "pnpm",
  "skit",
  "server",
  "bootstrap",
  "--url",
  publicOrigin,
  "--config",
  paths.configPath ?? configPath,
  "--wrangler",
  paths.wranglerPath ?? wranglerPath,
];

const shellSafeArgument = /^[A-Za-z0-9_./:@%+=,-]+$/;

export const shellCommand = (command) =>
  command
    .map((argument) =>
      shellSafeArgument.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
};

export const configurationMigration = (currentExists, legacyExists) => {
  if (currentExists && legacyExists) return "conflict";
  if (currentExists) return "current";
  if (legacyExists) return "migrate";
  return "missing";
};

const ensureConfigurationPath = async () => {
  const migration = configurationMigration(
    await exists(configPath),
    await exists(legacyConfigPath),
  );
  if (migration === "conflict")
    throw new DeploymentInputError(
      "both wrangler.jsonc and legacy wrangler.deploy.jsonc exist; reconcile them without overwriting either file",
    );
  if (migration === "migrate") {
    await rename(legacyConfigPath, configPath);
    console.log("Migrated legacy wrangler.deploy.jsonc to wrangler.jsonc");
  }
  return migration;
};

const readConfiguration = async () => {
  const migration = await ensureConfigurationPath();
  if (migration === "missing")
    throw new DeploymentInputError("deployment is not configured; run pnpm deploy:setup first");
  return parseDeploymentConfiguration(await readFile(configPath, "utf8"));
};

const writeConfiguration = async (configuration) => {
  const temporary = `${configPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, configPath);
};

const runWrangler = (args, options = {}) => {
  const selectedConfigPath = options.configPath ?? configPath;
  const result = spawnSync("wrangler", [...args, "--config", selectedConfigPath], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`wrangler ${args.join(" ")} failed with exit code ${result.status}`);
};

const buildDeployment = (configuration) => {
  const result = spawnSync("pnpm", ["build"], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: configPath },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm build failed with exit code ${result.status}`);
  return join(packageRoot, "web", "dist", configuration.name.replaceAll("-", "_"), "wrangler.json");
};

const inspectWrangler = (args, { withConfig = true } = {}) => {
  const commandArgs = withConfig ? [...args, "--config", configPath] : args;
  const result = spawnSync("wrangler", commandArgs, {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    stdout: result.stdout ?? "",
  };
};

const inspectWranglerJson = (args, description, options) => {
  const result = inspectWrangler(args, options);
  if (result.status !== 0) throw new Error(`${description}\n${result.output.trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Wrangler returned invalid JSON while ${description.toLowerCase()}`);
  }
};

const resolveCloudflareDeployment = async ({ workerName, account: requestedAccount }) => {
  const identity = inspectWranglerJson(["whoami", "--json"], "Unable to read Wrangler identity", {
    withConfig: false,
  });
  const account = selectAccount(identity.accounts, requestedAccount);
  const credential = inspectWranglerJson(
    ["auth", "token", "--json"],
    "Unable to read Wrangler authentication",
    { withConfig: false },
  );
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.id)}/workers/subdomain`,
    { headers: cloudflareAuthHeaders(credential) },
  );
  const payload = await response.json();
  if (!response.ok || payload?.success !== true || typeof payload.result?.subdomain !== "string")
    throw new Error(
      `Unable to read the Cloudflare account's workers.dev subdomain (HTTP ${response.status})`,
    );
  return {
    accountId: account.id,
    publicOrigin: workersDevOrigin(workerName, payload.result.subdomain),
  };
};

export const findDatabaseCollision = (databases, name) =>
  databases.find((database) => database.name === name);

export const withDatabaseBinding = (configuration, databaseName, databaseId) => ({
  ...configuration,
  d1_databases: [
    ...(configuration.d1_databases ?? []),
    {
      binding: "DB",
      database_name: databaseName,
      database_id: databaseId,
      migrations_dir: "migrations",
    },
  ],
});

export const withBucketBinding = (configuration, bucketName) => ({
  ...configuration,
  r2_buckets: [
    ...(configuration.r2_buckets ?? []),
    { binding: "SKIT_BLOBS", bucket_name: bucketName },
  ],
});

const findDatabase = (name) => {
  const result = inspectWrangler(["d1", "list", "--json"]);
  if (result.status !== 0)
    throw new Error(
      `unable to check whether D1 database '${name}' exists\n${result.output.trim()}`,
    );
  let databases;
  try {
    databases = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned an invalid response while listing D1 databases");
  }
  if (!Array.isArray(databases))
    throw new Error("Wrangler returned an invalid response while listing D1 databases");
  return findDatabaseCollision(databases, name);
};

export const bucketLookup = (status, output) => {
  if (status === 0) return "exists";
  if (output.includes("[code: 10006]")) return "absent";
  return "failed";
};

const findBucket = (name) => {
  const result = inspectWrangler(["r2", "bucket", "info", name]);
  const lookup = bucketLookup(result.status, result.output);
  if (lookup === "failed")
    throw new Error(`unable to check whether R2 bucket '${name}' exists\n${result.output.trim()}`);
  return lookup === "exists";
};

const deploy = async ({ installSecret = false, expectedOrigin } = {}) => {
  const currentConfiguration = await readConfiguration();
  const configuration = withApplicationHosting(currentConfiguration);
  if (JSON.stringify(configuration) !== JSON.stringify(currentConfiguration))
    await writeConfiguration(configuration);
  runWrangler(["d1", "migrations", "apply", "DB", "--remote"]);
  const deploymentConfigPath = buildDeployment(configuration);
  if (!installSecret) {
    runWrangler(["deploy"], { configPath: deploymentConfigPath });
    return;
  }

  const secretDirectory = await mkdtemp(join(tmpdir(), "skit-server-deploy-"));
  const secretFile = join(secretDirectory, "secrets.env");
  const outputFile = join(secretDirectory, "wrangler-output.ndjson");
  try {
    await writeFile(secretFile, `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}\n`, {
      mode: 0o600,
    });
    runWrangler(["deploy", "--secrets-file", secretFile], {
      configPath: deploymentConfigPath,
      env: { WRANGLER_OUTPUT_FILE_PATH: outputFile },
    });
    const targets = deployTargets(await readFile(outputFile, "utf8"));
    if (expectedOrigin && !targets.includes(expectedOrigin))
      throw new Error(`Wrangler deployed unexpected target(s): ${targets.join(", ") || "none"}`);
    return targets;
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
};

const setup = async (args) => {
  const options = parseSetupOptions(args);
  const plan = setupPlan(options);
  if (options.dryRun) {
    console.log(JSON.stringify({ configuration: initialConfiguration(options), plan }, null, 2));
    return;
  }

  const deployment = await resolveCloudflareDeployment(options);

  let configuration;
  try {
    configuration = await readConfiguration();
    if (configuration.name !== options.workerName)
      throw new DeploymentInputError("the existing deployment config targets a different Worker");
    if (configuration.account_id && configuration.account_id !== deployment.accountId)
      throw new DeploymentInputError("the existing deployment config targets a different account");
    configuration = {
      ...configuration,
      account_id: deployment.accountId,
      workers_dev: true,
      vars: {
        ...configuration.vars,
        ACCOUNT_REGISTRATION_MODE: "closed",
        PUBLIC_APP_ORIGIN: deployment.publicOrigin,
      },
    };
    if (options.emailFrom) configuration = withEmailSending(configuration, options.emailFrom);
    await writeConfiguration(configuration);
  } catch (cause) {
    if (!(cause instanceof DeploymentInputError) || !cause.message.startsWith("deployment is not"))
      throw cause;
    configuration = initialConfiguration({
      ...options,
      accountId: deployment.accountId,
      publicOrigin: deployment.publicOrigin,
    });
    await writeConfiguration(configuration);
  }

  if (!configuration.d1_databases?.some(({ binding }) => binding === "DB")) {
    const database = findDatabase(plan.databaseName);
    if (database) {
      configuration = withDatabaseBinding(configuration, plan.databaseName, database.uuid);
      await writeConfiguration(configuration);
    } else {
      runWrangler(["d1", "create", plan.databaseName, "--binding", "DB", "--update-config"]);
      configuration = await readConfiguration();
    }
  }
  if (!configuration.r2_buckets?.some(({ binding }) => binding === "SKIT_BLOBS")) {
    if (findBucket(plan.bucketName)) {
      configuration = withBucketBinding(configuration, plan.bucketName);
      await writeConfiguration(configuration);
    } else
      runWrangler([
        "r2",
        "bucket",
        "create",
        plan.bucketName,
        "--binding",
        "SKIT_BLOBS",
        "--update-config",
      ]);
  }

  await deploy({ installSecret: true, expectedOrigin: deployment.publicOrigin });
  console.log(`\nSKIT server deployed to ${deployment.publicOrigin}`);
  console.log(`Next: run ${shellCommand(bootstrapCommand(deployment.publicOrigin))}`);
};

const setDomain = async (args) => {
  const emailFrom = valueAfter(args, "--email-from");
  const positional = args.filter(
    (argument, index) =>
      !argument.startsWith("--") && (index === 0 || args[index - 1] !== "--email-from"),
  );
  const origin = positional[0];
  if (!origin) throw new DeploymentInputError("deploy:domain requires an HTTPS origin");
  let configuration = promoteToCustomDomain(await readConfiguration(), origin);
  if (emailFrom) configuration = withEmailSending(configuration, emailFrom);
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify(configuration, null, 2));
    return;
  }
  await writeConfiguration(configuration);
  await deploy();
  console.log(`\nCanonical server origin changed to ${configuration.vars.PUBLIC_APP_ORIGIN}`);
  console.log("Existing browser sessions and stored CLI credentials must be replaced.");
};

export const main = async (argv) => {
  const [command, ...args] = argv;
  if (command === "setup") return setup(args);
  if (command === "deploy") return deploy();
  if (command === "domain") return setDomain(args);
  throw new DeploymentInputError("expected one of: setup, deploy, domain");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  });
}
