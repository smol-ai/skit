import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valid } from "semver";

/** Read the contracts users received; a tag or development branch is not publication evidence. */
export async function readPublishedContracts(release = "latest", fetchRegistry = fetch) {
  if (release !== "latest" && valid(release) !== release)
    throw new Error("--release must name an exact published version, or latest");
  const request = async (url) => {
    const response = await fetchRegistry(url, {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Published contract baseline: HTTP ${response.status} at ${url}`);
    return response;
  };
  const metadata = await (
    await request(`https://registry.npmjs.org/@smolai%2fskit/${encodeURIComponent(release)}`)
  ).json();
  if (
    metadata.name !== "@smolai/skit" ||
    typeof metadata.version !== "string" ||
    !valid(metadata.version) ||
    (release !== "latest" && metadata.version !== release) ||
    typeof metadata.dist?.integrity !== "string" ||
    !metadata.dist.integrity.startsWith("sha512-")
  )
    throw new Error(
      "Published contract baseline has invalid package metadata or no SHA512 integrity",
    );
  const url = new URL(metadata.dist.tarball);
  if (url.origin !== "https://registry.npmjs.org" || url.username || url.password)
    throw new Error(
      "Published contract baseline tarball must come from https://registry.npmjs.org",
    );
  const bytes = Buffer.from(await (await request(url.href)).arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== metadata.dist.integrity)
    throw new Error(`Published contract baseline ${metadata.version}: tarball integrity mismatch`);

  const temporary = mkdtempSync(join(tmpdir(), "skit-published-contracts-"));
  try {
    const archive = join(temporary, "package.tgz");
    writeFileSync(archive, bytes);
    const tar = (args) =>
      execFileSync("tar", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    // Read exact members to stdout. Never extract archive-controlled paths onto the filesystem.
    const packaged = JSON.parse(tar(["-xOzf", archive, "package/package.json"]));
    if (packaged.name !== metadata.name || packaged.version !== metadata.version)
      throw new Error("Published contract baseline archive does not match its package metadata");
    const paths = tar(["-tzf", archive])
      .split("\n")
      .filter((path) => /^package\/contracts\/[^/]+\.json$/.test(path));
    if (new Set(paths).size !== paths.length)
      throw new Error("Published contract baseline contains duplicate contract files");
    const artifacts = Object.fromEntries(
      paths.map((path) => [path.slice("package/contracts/".length), tar(["-xOzf", archive, path])]),
    );
    const manifest = JSON.parse(artifacts["command-manifest.json"] ?? "null");
    if (!Array.isArray(manifest?.commands) || manifest.commands.length === 0)
      throw new Error("Published contract baseline has no command manifest");
    for (const command of manifest.commands) {
      if (!Array.isArray(command.outputSchemas))
        throw new Error("Published contract baseline has an invalid command manifest");
      for (const id of command.outputSchemas)
        if (JSON.parse(artifacts[`${id}.json`] ?? "null")?.$id !== id)
          throw new Error(`Published contract baseline is missing ${id}`);
    }
    return { version: metadata.version, integrity, artifacts };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
