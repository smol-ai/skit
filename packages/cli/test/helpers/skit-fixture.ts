import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function copySkitFixture(
  name:
    | "authored"
    | "duplicate-skills"
    | "generated-wrapper"
    | "hazardous"
    | "library"
    | "readme-authored",
  root: string,
) {
  const fixture = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  await cp(fixture, root, { recursive: true });
}
