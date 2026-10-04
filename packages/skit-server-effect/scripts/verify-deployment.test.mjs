import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyDeployment } from "./verify-deployment.mjs";
const build = { kind: "release", version: "0.2.0", commit: "abc123", buildId: "build-1" };
async function verify(expected = {}, healthBuild = build) {
  const output = [];
  const errors = [];
  const code = await verifyDeployment({
    environment: {
      SKIT_SERVER_URL: "https://registry.test",
      SKIT_SESSION_COOKIE: "session",
      ...expected,
    },
    request: async (url) =>
      Response.json(
        url.pathname === "/health"
          ? { schema: "skit.server.health.v1", status: "ok", build: healthBuild }
          : { ready: true, checks: [] },
      ),
    log: (message) => output.push(message),
    error: (message) => errors.push(message),
  });
  return { code, output, errors };
}
test("reports running identity and verifies the requested release", async () => {
  const result = await verify({
    SKIT_EXPECTED_SERVER_VERSION: "0.2.0",
    SKIT_EXPECTED_SERVER_COMMIT: "abc123",
  });
  assert.equal(result.code, 0);
  assert.match(result.output[1], /0.2.0.*release.*abc123.*build-1/);
});
test("fails a healthy deployment running a different commit", async () => {
  const result = await verify({ SKIT_EXPECTED_SERVER_COMMIT: "other" });
  assert.equal(result.code, 1);
  assert.match(result.errors[0], /expected commit other/);
});
test("accepts legacy health without expectations but fails identity verification", async () => {
  assert.equal((await verify({}, null)).code, 0);
  assert.equal((await verify({ SKIT_EXPECTED_SERVER_VERSION: "0.2.0" }, null)).code, 1);
});
