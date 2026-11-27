import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { guaranteeData } from "./guarantee-data.ts";

const args = process.argv.slice(2);
const onlyGuarantees = args.length === 2 && args[0] === "--only" && args[1] === "guarantees";
if (args.length && !onlyGuarantees) throw new Error("Usage: atlas:generate [--only guarantees]");
const output = fileURLToPath(new URL("../../atlas-data/", import.meta.url));
const index = join(output, "atlas.json");
const existing = onlyGuarantees
  ? await readFile(index, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    })
  : undefined;
if (existing === undefined) {
  await import("./generate.ts");
} else {
  const atlas = JSON.parse(existing);
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  Object.assign(atlas, await guaranteeData(root));
  const temp = await mkdtemp(join(output, ".guarantees-"));
  try {
    const pending = join(temp, "atlas.json");
    await writeFile(pending, JSON.stringify(atlas));
    await rename(pending, index);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  console.log("Updated Atlas guarantees and saved test reports.");
}
