import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPublishedContracts } from "./published-contracts.mjs";

const archive = (contracts, version = "0.3.0") => {
  const root = mkdtempSync(join(tmpdir(), "skit-contract-package-test-"));
  try {
    mkdirSync(join(root, "package/contracts"), { recursive: true });
    writeFileSync(
      join(root, "package/package.json"),
      JSON.stringify({ name: "@smolai/skit", version }),
    );
    for (const [name, contents] of Object.entries(contracts))
      writeFileSync(join(root, "package/contracts", name), contents);
    return execFileSync("tar", ["-czf", "-", "-C", root, "package"], {
      maxBuffer: 32 * 1024 * 1024,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const fixture = (
  contracts = {
    "command-manifest.json": JSON.stringify({
      commands: [{ stability: "stable", outputSchemas: ["skit.list.v2"] }],
    }),
    "skit.list.v2.json": JSON.stringify({
      $id: "skit.list.v2",
      type: "string",
      description: "large contract ".repeat(100_000),
    }),
  },
  packagedVersion,
) => {
  const bytes = archive(contracts, packagedVersion);
  const metadata = {
    name: "@smolai/skit",
    version: "0.3.0",
    dist: {
      tarball: "https://registry.npmjs.org/@smolai/skit/-/skit-0.3.0.tgz",
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    },
  };
  const requests = [];
  const fetchRegistry = async (url) => {
    requests.push(url);
    return url === metadata.dist.tarball ? new Response(bytes) : Response.json(metadata);
  };
  return { metadata, requests, fetchRegistry, contracts };
};

await test("reads integrity-verified published contracts, including files over the old Git buffer limit", async () => {
  const f = fixture();
  const published = await readPublishedContracts(undefined, f.fetchRegistry);
  assert.equal(published.version, "0.3.0");
  assert.equal(published.integrity, f.metadata.dist.integrity);
  assert.deepEqual(published.artifacts, f.contracts);
  assert.deepEqual(f.requests, [
    "https://registry.npmjs.org/@smolai%2fskit/latest",
    f.metadata.dist.tarball,
  ]);
});

await test("an explicit baseline selects a published package version, never a Git ref", async () => {
  const f = fixture();
  await readPublishedContracts("0.3.0", f.fetchRegistry);
  assert.equal(f.requests[0], "https://registry.npmjs.org/@smolai%2fskit/0.3.0");
  await assert.rejects(
    readPublishedContracts("origin/dev", f.fetchRegistry),
    /exact published version/,
  );
  await assert.rejects(
    readPublishedContracts("0.4.0", f.fetchRegistry),
    /invalid package metadata/,
  );
});

await test("a damaged archive fails instead of weakening the baseline", async () => {
  const f = fixture();
  f.metadata.dist.integrity = "sha512-wrong";
  await assert.rejects(readPublishedContracts(undefined, f.fetchRegistry), /integrity mismatch/);
});

await test("registry failure never becomes an empty compatibility baseline", async () => {
  await assert.rejects(
    readPublishedContracts(undefined, async () => new Response(null, { status: 503 })),
    /HTTP 503/,
  );
  await assert.rejects(
    readPublishedContracts(undefined, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
});

await test("a different package version inside an otherwise intact archive is rejected", async () => {
  const f = fixture(undefined, "0.2.0");
  await assert.rejects(
    readPublishedContracts(undefined, f.fetchRegistry),
    /does not match its package metadata/,
  );
});

await test("a published baseline must include its manifest and every referenced contract", async () => {
  const absent = fixture({});
  await assert.rejects(
    readPublishedContracts(undefined, absent.fetchRegistry),
    /no command manifest/,
  );
  const missing = fixture({
    "command-manifest.json": JSON.stringify({ commands: [{ outputSchemas: ["skit.list.v2"] }] }),
  });
  await assert.rejects(
    readPublishedContracts(undefined, missing.fetchRegistry),
    /missing skit.list.v2/,
  );
});
