import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { releaseCli, retryInstall } from "./release-cli.mjs";
import { releaseFixture } from "./release-test-fixture.mjs";

async function journey({
  published = false,
  mismatch = false,
  failPromotion = false,
  current,
  registryStatus = 200,
} = {}) {
  const fixture = releaseFixture();
  const calls = [];
  const content = "deterministic tarball";
  const integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`;
  const commit = fixture.git("rev-parse", "HEAD");
  try {
    await releaseCli({
      environment: {},
      sleep: async () => {},
      fetchRegistry: async () =>
        new Response(
          JSON.stringify({
            versions: published
              ? {
                  [fixture.metadata.version]: {
                    dist: { integrity: mismatch ? "wrong" : integrity },
                  },
                }
              : {},
            "dist-tags": current ? { alpha: current } : {},
          }),
          { status: registryStatus },
        ),
      run: (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === "pack") {
          writeFileSync("packages/cli/package.tgz", content);
          return JSON.stringify([{ filename: "package.tgz" }]);
        }
        if (command === process.execPath)
          return JSON.stringify({
            data: { version: fixture.metadata.version, build: { kind: "release", commit } },
          });
        if (args[0] === "dist-tag" && failPromotion) throw new Error("promotion permission denied");
        return "";
      },
    });
    return calls;
  } finally {
    fixture.close();
  }
}

test("builds only CLI dependencies, smokes before publication, then promotes", async () => {
  const calls = await journey();
  assert.deepEqual(calls[0].args, ["--filter", "@smolai/skit...", "build"]);
  const publish = calls.findIndex(({ args }) => args[0] === "publish");
  assert.ok(publish > calls.findIndex(({ args }) => args[0] === "install"));
  assert.ok(calls[publish].args.includes("staging"));
  assert.equal(calls.at(-1).args.at(-1), "alpha");
  const installs = calls.filter(({ args }) => args[0] === "install");
  assert.notEqual(installs[0].args[2], installs[1].args[2]);
});
test("resumes matching published bytes without republishing after promotion failure", async () => {
  await assert.rejects(journey({ failPromotion: true }), /permission denied/);
  const resumed = await journey({ published: true });
  assert.equal(
    resumed.some(({ args }) => args[0] === "publish"),
    false,
  );
  assert.equal(resumed.at(-1).args[0], "dist-tag");
});
test("rejects mismatched published bytes and backward tags", async () => {
  await assert.rejects(journey({ published: true, mismatch: true }), /differs/);
  await assert.rejects(journey({ current: "0.3.0-alpha.1" }), /backwards/);
  await assert.rejects(journey({ registryStatus: 503 }), /preflight failed/);
});
test("propagation retries are bounded and apply to installs only", async () => {
  let attempts = 0;
  const delays = [];
  await retryInstall(
    () => {
      if (++attempts < 3) throw new Error("ETARGET");
    },
    async (ms) => delays.push(ms),
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
  attempts = 0;
  await assert.rejects(
    retryInstall(
      () => {
        attempts++;
        throw new Error("offline");
      },
      async () => {},
    ),
    /offline/,
  );
  assert.equal(attempts, 5);
});
