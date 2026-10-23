import { Record, Result, Schema } from "effect";
import { isAlias, isMap, isScalar, parseDocument, type Document } from "yaml";
import type { HarnessName, InvocationPolicy } from "../contracts.js";
import { HarnessMetadataInvalid } from "../failures.js";

/**
 * The policy a native field can state: the model may choose the Skill on its own (`implicit`), or
 * only explicit invocation runs it. Absence states nothing, which is how `host-policy` is expressed:
 * it delegates to the Harness, and a lingering field would keep constraining it.
 */
export type NativeInvocationPolicy = Exclude<InvocationPolicy, "host-policy">;

/**
 * One Harness's native invocation metadata, read and written in SKIT's terms. Each adapter owns its
 * field's polarity, so no consumer needs to know which way a native boolean points.
 */
export interface InvocationMetadataAdapter {
  /** Native field, in the Harness's own notation. */
  readonly field: string;
  /** Metadata file, relative to the Skill directory. */
  readonly file: string;
  /** Whether the file must already exist for the Skill to be usable at all. */
  readonly required: boolean;
  /** Whether SKIT holds the author's artifact to carry a declared policy in this metadata. */
  readonly authored: boolean;
  /** Agent default leaves this native metadata intact rather than clearing its policy. */
  readonly hostPolicyPreservesNative: boolean;
  read(
    text: string | undefined,
    path: string,
  ): Result.Result<NativeInvocationPolicy | undefined, HarnessMetadataInvalid>;
  /** The file's new text, or `null` when the file should not exist. `host-policy` clears the field unless `hostPolicyPreservesNative`. */
  write(
    text: string | undefined,
    policy: InvocationPolicy,
    path: string,
  ): Result.Result<string | null, HarnessMetadataInvalid>;
  /** The native value that states a policy, as an author writes it. */
  notation(policy: NativeInvocationPolicy): string;
}

function emptyDocument(document: Document): boolean {
  const contents = document.contents as { items?: unknown[] } | null;
  return !contents || (Array.isArray(contents.items) && contents.items.length === 0);
}

const CLAUDE_FRONTMATTER = /^---\r?\n([\s\S]*?)^---(?=\r?\n|$)/m;
const CLAUDE_FIELD = "disable-model-invocation";

/** Claude's field disables model invocation, so `true` states `explicit`. */
const claudeAdapter: InvocationMetadataAdapter = {
  field: CLAUDE_FIELD,
  file: "SKILL.md",
  required: true,
  authored: true,
  hostPolicyPreservesNative: false,
  read: (text, path) =>
    Result.gen(function* () {
      const match = text?.match(CLAUDE_FRONTMATTER);
      if (!match) return undefined;
      const value = (yield* claudeDocumentResult(match[1], path)).get(CLAUDE_FIELD);
      return typeof value === "boolean" ? (value ? "explicit" : "implicit") : undefined;
    }),
  write: (text, policy, path) =>
    Result.gen(function* () {
      const body = text ?? "";
      const value = policy === "host-policy" ? undefined : policy === "explicit";
      const newline = body.includes("\r\n") ? "\r\n" : "\n";
      const match = body.match(CLAUDE_FRONTMATTER);
      if (!match)
        return value === undefined
          ? body
          : `---${newline}${CLAUDE_FIELD}: ${value}${newline}---${newline}${body}`;
      const document = yield* claudeDocumentResult(match[1], path);
      if (value === undefined) {
        if (document.get(CLAUDE_FIELD) === undefined) return body;
        document.delete(CLAUDE_FIELD);
      } else document.set(CLAUDE_FIELD, value);
      const serialized = emptyDocument(document)
        ? ""
        : document.toString({ lineWidth: 0 }).replace(/\n/g, newline);
      return `---${newline}${serialized}---${body.slice(match[0].length)}`;
    }),
  notation: (policy) => String(policy === "explicit"),
};

const CODEX_FIELD = ["policy", "allow_implicit_invocation"] as const;

const claudeDocumentResult = (
  frontmatter: string,
  path: string,
): Result.Result<Document, HarnessMetadataInvalid> => {
  const document = parseDocument(frontmatter.replace(/\r?\n$/, ""));
  return document.errors.length
    ? Result.fail(new HarnessMetadataInvalid({ path, kind: "SKILL.md frontmatter" }))
    : Result.succeed(document);
};

const codexDocumentResult = (
  text: string,
  path: string,
): Result.Result<Document, HarnessMetadataInvalid> => {
  const document = parseDocument(text);
  return document.errors.length
    ? Result.fail(new HarnessMetadataInvalid({ path, kind: "Codex metadata" }))
    : Result.succeed(document);
};

/**
 * The Codex field's value as Codex's loader sees it. An alias resolves to its anchored node, which
 * expands nothing else; a `policy` that is not a mapping, or a value that is not a boolean, is
 * invalid metadata rather than an absent policy.
 */
const codexFieldResult = (
  document: Document,
  path: string,
): Result.Result<boolean | undefined, HarnessMetadataInvalid> => {
  const invalid = Result.fail(new HarnessMetadataInvalid({ path, kind: "Codex metadata" }));
  // An alias to an unknown anchor names metadata that is not there; it is invalid, not absent.
  const unresolved = Symbol("unresolved alias");
  const resolved = (node: unknown) =>
    isAlias(node) ? (node.resolve(document) ?? unresolved) : node;
  let node = resolved(document.contents);
  for (const key of CODEX_FIELD) {
    if (node === unresolved) return invalid;
    if (node === null || node === undefined) return Result.succeed(undefined);
    if (!isMap(node)) return invalid;
    node = resolved(node.get(key, true));
  }
  if (node === unresolved) return invalid;
  if (node === undefined) return Result.succeed(undefined);
  return isScalar(node) && typeof node.value === "boolean" ? Result.succeed(node.value) : invalid;
};

/**
 * Codex reads `agents/openai.yaml`, the only file its loader consults for invocation policy; the
 * field allows implicit invocation, so `true` states `implicit`.
 */
const codexAdapter: InvocationMetadataAdapter = {
  field: "policy.allow_implicit_invocation",
  file: "agents/openai.yaml",
  required: false,
  authored: true,
  hostPolicyPreservesNative: false,
  read: (text, path) =>
    Result.gen(function* () {
      if (text === undefined) return undefined;
      const value = yield* codexFieldResult(yield* codexDocumentResult(text, path), path);
      return value === undefined ? undefined : value ? "implicit" : "explicit";
    }),
  write: (text, policy, path) =>
    Result.gen(function* () {
      const document = yield* codexDocumentResult(text ?? "", path);
      const current = yield* codexFieldResult(document, path);
      // Rewriting through an aliased mapping would change every other reference to its anchor.
      if (isAlias(document.contents) || isAlias(document.get("policy", true)))
        return yield* Result.fail(new HarnessMetadataInvalid({ path, kind: "Codex metadata" }));
      if (policy === "host-policy") {
        if (text === undefined) return null;
        if (current === undefined) return text;
        document.deleteIn([...CODEX_FIELD]);
        const policyNode = document.get("policy") as { items?: unknown[] } | undefined;
        if (policyNode && Array.isArray(policyNode.items) && policyNode.items.length === 0)
          document.delete("policy");
        return emptyDocument(document) ? null : document.toString();
      }
      document.setIn([...CODEX_FIELD], policy === "implicit");
      return document.toString();
    }),
  notation: (policy) => String(policy === "implicit"),
};

const OPENCODE_FIELD = ["metadata", "opencode/autoinvoke"] as const;

const opencodeDocumentResult = (frontmatter: string, path: string) =>
  Result.gen(function* () {
    const document = yield* claudeDocumentResult(frontmatter, path);
    const metadata = document.get("metadata", true);
    if (metadata !== undefined && !isMap(metadata))
      return yield* Result.fail(new HarnessMetadataInvalid({ path, kind: "OpenCode metadata" }));
    return document;
  });

/**
 * OpenCode V2 reads `opencode/autoinvoke` from the portable Agent Skills metadata map. V1
 * accepts and ignores the extension, so projection is version-independent even though enforcement
 * is not. Strings keep the metadata map valid for other Agent Skills consumers.
 */
const opencodeAdapter: InvocationMetadataAdapter = {
  field: "metadata.opencode/autoinvoke",
  file: "SKILL.md",
  required: true,
  authored: false,
  hostPolicyPreservesNative: false,
  read: (text, path) =>
    Result.gen(function* () {
      const match = text?.match(CLAUDE_FRONTMATTER);
      if (!match) return undefined;
      const document = yield* claudeDocumentResult(match[1], path);
      if (!isMap(document.get("metadata", true))) return undefined;
      const value = document.getIn([...OPENCODE_FIELD]);
      const normalized = typeof value === "string" ? value.toLowerCase() : value;
      return normalized === true || normalized === "true"
        ? "implicit"
        : normalized === false || normalized === "false"
          ? "explicit"
          : undefined;
    }),
  write: (text, policy, path) =>
    Result.gen(function* () {
      const body = text ?? "";
      const value = policy === "host-policy" ? undefined : policy === "implicit";
      const newline = body.includes("\r\n") ? "\r\n" : "\n";
      const match = body.match(CLAUDE_FRONTMATTER);
      if (!match)
        return value === undefined
          ? body
          : `---${newline}metadata:${newline}  opencode/autoinvoke: "${value}"${newline}---${newline}${body}`;
      const document = yield* opencodeDocumentResult(match[1], path);
      if (value === undefined) {
        if (document.getIn([...OPENCODE_FIELD]) === undefined) return body;
        document.deleteIn([...OPENCODE_FIELD]);
        const metadata = document.get("metadata", true);
        if (isMap(metadata) && metadata.items.length === 0) document.delete("metadata");
      } else document.setIn([...OPENCODE_FIELD], String(value));
      const serialized = document.toString({ lineWidth: 0 }).replace(/\n/g, newline);
      return `---${newline}${emptyDocument(document) ? "" : serialized}---${body.slice(match[0].length)}`;
    }),
  notation: (policy) => `"${policy === "implicit"}"`,
};

const DEVIN_FIELD = "triggers";
const DEVIN_MODEL_TRIGGER = "model";
const DEVIN_USER_TRIGGER = "user";
const devinTriggers = (policy: NativeInvocationPolicy) =>
  policy === "implicit" ? [DEVIN_USER_TRIGGER, DEVIN_MODEL_TRIGGER] : [DEVIN_USER_TRIGGER];

/**
 * Devin reads `triggers` from the Skill's own frontmatter: `["user", "model"]` lets Devin choose
 * the Skill on its own, `["user"]` restricts it to explicit invocation.
 * See https://docs.devin.ai/product-guides/skills.
 *
 * SKIT never holds the author to it: `triggers` names permitted invokers rather than a SKIT-owned
 * switch, so SKIT reads what the author wrote and writes it into Projections, but never demands the
 * artifact carry it.
 */
const devinAdapter: InvocationMetadataAdapter = {
  field: DEVIN_FIELD,
  file: "SKILL.md",
  required: true,
  authored: false,
  hostPolicyPreservesNative: true,
  read: (text, path) =>
    Result.gen(function* () {
      const match = text?.match(CLAUDE_FRONTMATTER);
      if (!match) return undefined;
      const value = (yield* claudeDocumentResult(match[1], path)).get(DEVIN_FIELD, true) as
        | { toJSON?: () => unknown }
        | undefined;
      const triggers = value?.toJSON?.() ?? value;
      if (!Array.isArray(triggers)) return undefined;
      return triggers.includes(DEVIN_MODEL_TRIGGER) ? "implicit" : "explicit";
    }),
  write: (text, policy, path) =>
    Result.gen(function* () {
      const body = text ?? "";
      // `host-policy` defers to Devin, and Devin's default is whatever `triggers` already says.
      if (policy === "host-policy") return body;
      const triggers = devinTriggers(policy);
      const newline = body.includes("\r\n") ? "\r\n" : "\n";
      const match = body.match(CLAUDE_FRONTMATTER);
      if (!match)
        return `---${newline}${DEVIN_FIELD}: [${triggers.join(", ")}]${newline}---${newline}${body}`;
      const document = yield* claudeDocumentResult(match[1], path);
      document.set(DEVIN_FIELD, document.createNode(triggers, { flow: true }));
      const serialized = document.toString({ lineWidth: 0 }).replace(/\n/g, newline);
      return `---${newline}${serialized}---${body.slice(match[0].length)}`;
    }),
  notation: (policy) => `[${devinTriggers(policy).join(", ")}]`,
};

export const invocationMetadataAdapters: Record<HarnessName, InvocationMetadataAdapter> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  devin: devinAdapter,
};

/** The Harnesses whose declaration SKIT holds the author to, in the adapters' order. */
export const AuthoredInvocationHarness = Schema.Literals(
  Record.keys(invocationMetadataAdapters).filter(
    (harness) => invocationMetadataAdapters[harness].authored,
  ),
);
export type AuthoredInvocationHarness = typeof AuthoredInvocationHarness.Type;
