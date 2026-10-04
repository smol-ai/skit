import { execFileSync } from "node:child_process";

export function buildInfo(metadata, environment = process.env) {
  let commit;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    /* Source archives have no Git metadata. */
  }
  const release = environment.SKIT_RELEASE === "1";
  if (release) {
    const expectedTag = `${metadata.name}@${metadata.version}`;
    if (!/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/.test(metadata.version))
      throw new Error("Unsupported release version");
    const tags = execFileSync("git", ["tag", "--points-at", "HEAD"], { encoding: "utf8" })
      .trim()
      .split("\n");
    if (!commit || !tags.includes(expectedTag))
      throw new Error(`Release requires tag ${expectedTag} at HEAD`);
    if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
      throw new Error("Release requires a clean tree");
  }
  return {
    kind: release ? "release" : "dev",
    version: metadata.version,
    ...(commit ? { commit } : {}),
  };
}
