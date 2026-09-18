import { createHash } from "node:crypto";
import type { Digest, SyncFileVersion, SyncPlan } from "../contracts.js";

function digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function same(left?: SyncFileVersion, right?: SyncFileVersion): boolean {
  return left?.digest === right?.digest;
}

function isText(file: SyncFileVersion): boolean {
  return (
    file.mediaType.startsWith("text/") ||
    /(?:json|yaml|toml|javascript|typescript)/.test(file.mediaType)
  );
}

function lineMerge(base: string, local: string, remote: string): string | null {
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  if (baseLines.length !== localLines.length || baseLines.length !== remoteLines.length)
    return null;
  const output: string[] = [];
  for (let index = 0; index < baseLines.length; index++) {
    const baseLine = baseLines[index];
    const localLine = localLines[index];
    const remoteLine = remoteLines[index];
    if (localLine === remoteLine) output.push(localLine);
    else if (localLine === baseLine) output.push(remoteLine);
    else if (remoteLine === baseLine) output.push(localLine);
    else return null;
  }
  return output.join("\n");
}

export function planThreeWayRecords<T>(
  base: Record<string, T>,
  local: Record<string, T>,
  remote: Record<string, T>,
  equal: (left: T | undefined, right: T | undefined) => boolean,
) {
  const records: Record<string, T> = {};
  const conflicts: string[] = [];
  const changedKeys: string[] = [];
  const keys = [
    ...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]),
  ].sort();
  for (const key of keys) {
    const baseValue = base[key];
    const localValue = local[key];
    const remoteValue = remote[key];
    if (equal(localValue, remoteValue)) {
      if (localValue !== undefined) records[key] = localValue;
      continue;
    }
    if (equal(baseValue, localValue)) {
      if (remoteValue !== undefined) records[key] = remoteValue;
      changedKeys.push(key);
      continue;
    }
    if (equal(baseValue, remoteValue)) {
      if (localValue !== undefined) records[key] = localValue;
      changedKeys.push(key);
      continue;
    }
    conflicts.push(key);
  }
  return { records, conflicts, changedKeys };
}

/** Plan a deterministic, side-effect-free three-way merge. */
export function planThreeWaySync(
  base: Record<string, SyncFileVersion>,
  local: Record<string, SyncFileVersion>,
  remote: Record<string, SyncFileVersion>,
): SyncPlan {
  const files: Record<string, SyncFileVersion> = {};
  const conflicts: SyncPlan["conflicts"] = [];
  const changedPaths: string[] = [];
  const paths = [
    ...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]),
  ].sort();
  for (const path of paths) {
    const baseFile = base[path];
    const localFile = local[path];
    const remoteFile = remote[path];
    if (same(localFile, remoteFile)) {
      if (localFile) files[path] = localFile;
      continue;
    }
    if (same(baseFile, localFile)) {
      if (remoteFile) files[path] = remoteFile;
      changedPaths.push(path);
      continue;
    }
    if (same(baseFile, remoteFile)) {
      if (localFile) files[path] = localFile;
      changedPaths.push(path);
      continue;
    }
    if (!localFile || !remoteFile) {
      conflicts.push({ path, kind: "delete_modify" });
      continue;
    }
    if (path === "README.md") {
      conflicts.push({ path, kind: "descriptor" });
      continue;
    }
    if (!baseFile || !isText(baseFile) || !isText(localFile) || !isText(remoteFile)) {
      conflicts.push({ path, kind: "binary" });
      continue;
    }
    const merged = lineMerge(
      new TextDecoder().decode(baseFile.bytes),
      new TextDecoder().decode(localFile.bytes),
      new TextDecoder().decode(remoteFile.bytes),
    );
    if (merged === null) {
      conflicts.push({ path, kind: "both_modified" });
      continue;
    }
    const bytes = new TextEncoder().encode(merged);
    files[path] = { bytes, digest: digest(bytes), mediaType: localFile.mediaType };
    changedPaths.push(path);
  }
  return { files, conflicts, changedPaths };
}
