import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(
  await readFile(
    new URL("../test/fixtures/collections/full-manifest.json", import.meta.url),
    "utf8",
  ),
);
const cache = new URL("../../../node_modules/.cache/skit-collections/", import.meta.url);
await mkdir(cache, { recursive: true });

for (const collection of manifest) {
  const destination = new URL(`${collection.commit}.tar.gz`, cache);
  let bytes;
  let cached = true;
  try {
    bytes = await readFile(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    cached = false;
    const response = await fetch(collection.url);
    if (!response.ok) throw new Error(`${collection.repository}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== collection.sha256) {
    throw new Error(
      `${collection.repository}: archive checksum mismatch; review the upstream pin or remove the damaged cache entry`,
    );
  }
  if (!cached) {
    const temporary = new URL(`${collection.commit}.${process.pid}.tmp`, cache);
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  }
  console.log(
    `${collection.repository} ${collection.commit}: verified ${fileURLToPath(destination)}`,
  );
}
