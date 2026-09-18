import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { planThreeWaySync, type SyncFileVersion } from "../src/index.js";

function file(content: string, mediaType = "text/plain"): SyncFileVersion {
  const bytes = new TextEncoder().encode(content);
  return {
    bytes,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    mediaType,
  };
}

describe("three-way source sync", () => {
  test("combines independent changes deterministically", () => {
    const base = { "a.txt": file("base"), "b.txt": file("base") };
    const local = { "a.txt": file("local"), "b.txt": base["b.txt"] };
    const remote = { "a.txt": base["a.txt"], "b.txt": file("remote") };
    const plan = planThreeWaySync(base, local, remote);
    expect(plan.conflicts).toEqual([]);
    expect(plan.changedPaths).toEqual(["a.txt", "b.txt"]);
    expect(new TextDecoder().decode(plan.files["a.txt"].bytes)).toBe("local");
    expect(new TextDecoder().decode(plan.files["b.txt"].bytes)).toBe("remote");
  });

  test("reports descriptor, binary, and delete-modify conflicts without choosing a side", () => {
    const base = {
      "README.md": file("base"),
      "asset.bin": file("base", "application/octet-stream"),
      "removed.txt": file("base"),
    };
    const plan = planThreeWaySync(
      base,
      {
        "README.md": file("local"),
        "asset.bin": file("local", "application/octet-stream"),
      },
      {
        "README.md": file("remote"),
        "asset.bin": file("remote", "application/octet-stream"),
        "removed.txt": file("remote"),
      },
    );
    expect(plan.conflicts).toEqual([
      { path: "README.md", kind: "descriptor" },
      { path: "asset.bin", kind: "binary" },
      { path: "removed.txt", kind: "delete_modify" },
    ]);
  });
});
