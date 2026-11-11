import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { termDebt } from "../architecture/terms.mjs";

const root = resolve(import.meta.dirname, "..");

/**
 * The verbs CONTEXT.md's verb table says to avoid. An entry of more than one word, such as
 * "publish for anything but Releases", depends on what it is said about, which a word alone cannot
 * show, so it is left to review.
 */
export function bannedVerbs(glossary) {
  const verbs = glossary.slice(glossary.indexOf("## Verbs"));
  const avoid = verbs.split("\n").find((line) => line.startsWith("_Avoid_:"));
  if (avoid === undefined) throw new Error("CONTEXT.md has no _Avoid_ line under ## Verbs");
  return avoid
    .slice("_Avoid_:".length)
    .replace(/\.$/, "")
    .split(",")
    .map((entry) => entry.trim().replace(/^and /, ""))
    .filter((entry) => /^[a-z]+$/.test(entry));
}

// Nouns that do not start with their verb's stem.
const irregular = { acquire: ["acquisition"], retain: ["retention"] };
const endings = new Set([
  "",
  "s",
  "es",
  "ed",
  "d",
  "ing",
  "ings",
  "ion",
  "ions",
  "ation",
  "ations",
  "iation",
  "iations",
  "ment",
  "ments",
  "ement",
  "ements",
  "er",
  "ers",
]);

/** The banned verb a word is a form of, if any: retained, retaining and retention are all retain. */
export function bannedForm(word, verbs) {
  const lower = word.toLowerCase();
  return verbs.find((verb) => {
    const stem = verb.endsWith("e") ? verb.slice(0, -1) : verb;
    return (
      (lower.startsWith(stem) && endings.has(lower.slice(stem.length))) ||
      (irregular[verb] ?? []).some((noun) => lower === noun || lower === `${noun}s`)
    );
  });
}

// Codex and Claude Code call their per-repository settings a project; naming theirs is not the
// banned verb.
const harnessProject = (verb, word, whole) =>
  verb === "project" &&
  ["project", "projects"].includes(word.toLowerCase()) &&
  /codex|claude/i.test(whole);

const nameWords = (name) => name.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
const proseWords = (text) => text.match(/[A-Za-z]+/g) ?? [];
// Contract and stored-format names have no spaces; text a person reads does.
const isProse = (text) => /[A-Za-z]\s+[A-Za-z]/.test(text);

export const termRules = {
  "banned-terms": {
    meta: {
      type: "problem",
      docs: { description: "Use CONTEXT.md's verbs, not the ones it says to avoid" },
      messages: {
        banned:
          '"{{word}}" is a form of "{{verb}}", which CONTEXT.md says to avoid, in {{entry}}. Use the verb table and glossary terms: a retained copy is a Collection Version, a projection is an Installed Skill, a binding is what is Enabled at a Scope.',
      },
    },
    create(context) {
      const verbs = bannedVerbs(readFileSync(resolve(root, "CONTEXT.md"), "utf8"));
      const file = relative(root, context.filename);
      // Each file may keep exactly the occurrences recorded when the rule arrived, and no more.
      const allowed = new Map();
      for (const entry of termDebt[file] ?? []) allowed.set(entry, (allowed.get(entry) ?? 0) + 1);
      const check = (node, kind, whole, words) => {
        for (const word of words) {
          const verb = bannedForm(word, verbs);
          if (verb === undefined || harnessProject(verb, word, `${whole} ${file}`)) continue;
          const entry = `${kind} ${whole.replace(/\s+/g, " ").trim()}`;
          const remaining = allowed.get(entry) ?? 0;
          if (remaining > 0) allowed.set(entry, remaining - 1);
          else
            context.report({
              node,
              messageId: "banned",
              data: { word, verb, entry: JSON.stringify(entry) },
            });
          return;
        }
      };
      const declared = (node) => {
        if (node?.type === "Identifier") check(node, "name", node.name, nameWords(node.name));
      };
      return {
        VariableDeclarator: (node) => declared(node.id),
        FunctionDeclaration: (node) => declared(node.id),
        ClassDeclaration: (node) => declared(node.id),
        TSInterfaceDeclaration: (node) => declared(node.id),
        TSTypeAliasDeclaration: (node) => declared(node.id),
        TSEnumDeclaration: (node) => declared(node.id),
        MethodDefinition: (node) => {
          if (!node.computed) declared(node.key);
        },
        PropertyDefinition: (node) => {
          if (!node.computed) declared(node.key);
        },
        Literal(node) {
          if (typeof node.value === "string" && isProse(node.value))
            check(node, "text", node.value, proseWords(node.value));
        },
        TemplateLiteral(node) {
          const text = node.quasis
            .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
            .join("${…}");
          if (isProse(text)) check(node, "text", text, proseWords(text));
        },
      };
    },
  },
};
