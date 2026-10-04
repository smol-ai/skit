import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { buildInfo } from "./build-info.mjs";
import { releaseFixture } from "./release-test-fixture.mjs";

test("release validation requires the artifact tag, supported version, and clean source", () => {
  const fixture = releaseFixture();
  try {
    const release = buildInfo(fixture.metadata, { SKIT_RELEASE: "1" });
    assert.equal(release.kind, "release");
    assert.equal(release.commit, fixture.git("rev-parse", "HEAD"));
    assert.throws(
      () =>
        buildInfo({ name: "@smolai/skit-server-effect", version: "0.1.0" }, { SKIT_RELEASE: "1" }),
      /requires tag/,
    );
    assert.throws(
      () => buildInfo({ ...fixture.metadata, version: "0.2.0-next.1" }, { SKIT_RELEASE: "1" }),
      /Unsupported/,
    );
    writeFileSync("untracked", "dirty");
    assert.throws(() => buildInfo(fixture.metadata, { SKIT_RELEASE: "1" }), /clean tree/);
    assert.equal(buildInfo(fixture.metadata, {}).kind, "dev");
  } finally {
    fixture.close();
  }
});
