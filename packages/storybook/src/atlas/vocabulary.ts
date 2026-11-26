import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Atlas } from "./data.ts";

/** CONTEXT.md owns the language; Atlas presents its definitions without a second glossary. */
export async function domainVocabulary(root: string): Promise<Pick<Atlas, "vocabulary" | "verbs">> {
  const text = await readFile(join(root, "CONTEXT.md"), "utf8");
  const vocabulary: Atlas["vocabulary"][number][] = [];
  let group = "";
  for (const section of text.split(/^### /m).slice(1)) {
    group = section.slice(0, section.indexOf("\n"));
    for (const match of section.matchAll(/\*\*([^\n]+)\*\*:\n([\s\S]*?)(?=\n\*\*|$)/g)) {
      const [meaning, avoid = ""] = match[2]!.trim().split(/\n_Avoid_:\s*/);
      vocabulary.push({ group, term: match[1]!, meaning: meaning!.trim(), avoid: avoid.trim() });
    }
  }
  const table = text.split("## Verbs\n")[1]?.split("## Language")[0] ?? "";
  const verbs = [...table.matchAll(/^\| ([^|]+) \| ([^|]+) \|$/gm)]
    .slice(2)
    .map((match) => ({ verb: match[1]!.trim(), meaning: match[2]!.trim() }));
  if (!vocabulary.length || !verbs.length)
    throw new Error("CONTEXT.md vocabulary or verbs missing");
  return { vocabulary, verbs };
}
