import { pathToFileURL } from "node:url";
import { describeBuild } from "./build.mjs";

export async function verifyDeployment({
  environment = process.env,
  request = fetch,
  log = console.log,
  error = console.error,
} = {}) {
  const base = environment.SKIT_SERVER_URL;
  const cookie = environment.SKIT_SESSION_COOKIE;
  const timeout = () => AbortSignal.timeout(10_000);
  if (!base) {
    error("SKIT_SERVER_URL is required");
    return 2;
  }
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    error("SKIT_SERVER_URL must be a valid absolute URL");
    return 2;
  }
  let code = 0;
  const health = await request(new URL("/health", origin), { signal: timeout() });
  const healthBody = await health.json().catch(() => null);
  if (!health.ok || healthBody?.schema !== "skit.server.health.v1" || healthBody.status !== "ok") {
    error(`Liveness failed: HTTP ${health.status}`);
    code = 1;
  } else {
    log(`Liveness: ok (${origin})`);
    const build = healthBody.build;
    if (typeof build?.version === "string" && typeof build?.kind === "string")
      log(`Running SKIT server ${describeBuild(build)}`);
    else log("Running build identity: unavailable");
    for (const [field, expected] of [
      ["version", environment.SKIT_EXPECTED_SERVER_VERSION],
      ["commit", environment.SKIT_EXPECTED_SERVER_COMMIT],
    ]) {
      if (expected && build?.[field] !== expected) {
        error(
          `Build mismatch: expected ${field} ${expected}, received ${build?.[field] ?? "unknown"}`,
        );
        code = 1;
      }
    }
  }
  if (!cookie) {
    error("SKIT_SESSION_COOKIE is required for operator readiness verification");
    return code || 2;
  }
  const response = await request(new URL("/api/operator/readiness", origin), {
    headers: { cookie },
    signal: timeout(),
  });
  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.checks)) {
    error(`Readiness failed: HTTP ${response.status}`);
    return 1;
  }
  for (const check of body.checks)
    log(`${check.status === "ok" ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  return !response.ok || body.ready !== true ? 1 : code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await verifyDeployment();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
