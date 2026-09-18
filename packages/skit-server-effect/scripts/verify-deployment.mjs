const base = process.env.SKIT_SERVER_URL;
const cookie = process.env.SKIT_SESSION_COOKIE;
const timeout = () => AbortSignal.timeout(10_000);

if (!base) {
  console.error("SKIT_SERVER_URL is required");
  process.exitCode = 2;
} else {
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    console.error("SKIT_SERVER_URL must be a valid absolute URL");
    process.exitCode = 2;
  }

  if (origin) {
    const health = await fetch(new URL("/health", origin), { signal: timeout() });
    const healthBody = await health.json().catch(() => null);
    if (!health.ok || healthBody?.schema !== "skit.server.health.v1") {
      console.error(`Liveness failed: HTTP ${health.status}`);
      process.exitCode = 1;
    } else console.log(`Liveness: ok (${origin})`);

    if (!cookie) {
      console.error("SKIT_SESSION_COOKIE is required for operator readiness verification");
      process.exitCode = 2;
    } else {
      const response = await fetch(new URL("/api/operator/readiness", origin), {
        headers: { cookie },
        signal: timeout(),
      });
      const body = await response.json().catch(() => null);
      if (!body || !Array.isArray(body.checks)) {
        console.error(`Readiness failed: HTTP ${response.status}`);
        process.exitCode = 1;
      } else {
        for (const check of body.checks)
          console.log(`${check.status === "ok" ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
        if (!response.ok || body.ready !== true) process.exitCode = 1;
      }
    }
  }
}
