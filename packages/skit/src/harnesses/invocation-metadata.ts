import { Result, Schema } from "effect";
import { isMap, parseDocument, type Document } from "yaml";
import type { InvocationPolicy } from "../contracts.js";
import { HarnessMetadataInvalid } from "../failures.js";

/** Harnesses whose native metadata can express a SKIT invocation declaration. */
export const INVOCATION_HARNESSES = ["claude-code", "codex", "opencode", "devin"] as const;

/**
 * Harnesses whose declaration SKIT holds the author to. Devin is deliberately absent: its
 * `triggers` field names permitted invokers rather than a SKIT-owned switch, so SKIT reads what
 * the author wrote and writes it into Projections, but never demands the artifact carry it.
 */
export const AUTHORED_INVOCATION_HARNESSES = ["claude-code", "codex"] as const;
export const AuthoredInvocationHarness = Schema.Literals(AUTHORED_INVOCATION_HARNESSES);
export type AuthoredInvocationHarness = typeof AuthoredInvocationHarness.Type;

export function requiresAuthoredInvocation(harness: InvocationHarness): boolean {
  return (AUTHORED_INVOCATION_HARNESSES as readonly string[]).includes(harness);
}
export const InvocationHarness = Schema.Literals(INVOCATION_HARNESSES);
export type InvocationHarness = typeof InvocationHarness.Type;

/**
 * The native value a Harness must carry for a declared policy. `undefined` means the field is
 * absent: `host-policy` delegates to the Harness, and a lingering field would keep constraining it.
 */
export function expectedNativeInvocation(
  harness: InvocationHarness,
  policy: InvocationPolicy,
): boolean | undefined {
  if (policy === "host-policy") return undefined;
  return harness === "claude-code" ? policy === "explicit" : policy === "implicit";
}

export interface InvocationMetadataAdapter {
  readonly harness: InvocationHarness;
  /** Native field, in the Harness's own notation. */
  readonly field: string;
  /** Metadata file, relative to the Skill directory. */
  readonly file: string;
  /** Whether the file must already exist for the Skill to be usable at all. */
  readonly required: boolean;
  read(
    text: string | undefined,
    path: string,
  ): Result.Result<boolean | undefined, HarnessMetadataInvalid>;
  /** The file's new text, or `null` when the file should not exist. */
  write(
    text: string | undefined,
    value: boolean | undefined,
    path: string,
  ): Result.Result<string | null, HarnessMetadataInvalid>;
}

function emptyDocument(document: Document): boolean {
  const contents = document.contents as { items?: unknown[] } | null;
  return !contents || (Array.isArray(contents.items) && contents.items.length === 0);
}

const CLAUDE_FRONTMATTER = /^---\r?\n([\s\S]*?)^---(?=\r?\n|$)/m;

const claudeAdapter: InvocationMetadataAdapter = {
  harness: "claude-code",
  field: "disable-model-invocation",
  file: "SKILL.md",
  required: true,
  read(text, path) {
    if (text === undefined) return Result.succeed(undefined);
    const match = text.match(CLAUDE_FRONTMATTER);
    if (!match) return Result.succeed(undefined);
    const parsed = claudeDocumentResult(match[1], path);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const value = parsed.success.get("disable-model-invocation");
    return Result.succeed(typeof value === "boolean" ? value : undefined);
  },
  write(text, value, path) {
    const body = text ?? "";
    const newline = body.includes("\r\n") ? "\r\n" : "\n";
    const match = body.match(CLAUDE_FRONTMATTER);
    if (!match)
      return Result.succeed(
        value === undefined
          ? body
          : `---${newline}${this.field}: ${value}${newline}---${newline}${body}`,
      );
    const parsed = claudeDocumentResult(match[1], path);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const document = parsed.success;
    if (value === undefined) {
      if (document.get(this.field) === undefined) return Result.succeed(body);
      document.delete(this.field);
    } else document.set(this.field, value);
    const serialized = emptyDocument(document)
      ? ""
      : document.toString({ lineWidth: 0 }).replace(/\n/g, newline);
    return Result.succeed(`---${newline}${serialized}---${body.slice(match[0].length)}`);
  },
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

const codexAdapter: InvocationMetadataAdapter = {
  harness: "codex",
  field: "policy.allow_implicit_invocation",
  file: "agents/openai.yaml",
  required: false,
  read(text, path) {
    if (text === undefined) return Result.succeed(undefined);
    const parsed = codexDocumentResult(text, path);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const value = parsed.success.getIn([...CODEX_FIELD]);
    return Result.succeed(typeof value === "boolean" ? value : undefined);
  },
  write(text, value, path) {
    const parsed = codexDocumentResult(text ?? "", path);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const document = parsed.success;
    if (value === undefined) {
      if (text === undefined) return Result.succeed(null);
      if (document.getIn([...CODEX_FIELD]) === undefined) return Result.succeed(text);
      document.deleteIn([...CODEX_FIELD]);
      const policy = document.get("policy") as { items?: unknown[] } | undefined;
      if (policy && Array.isArray(policy.items) && policy.items.length === 0)
        document.delete("policy");
      return Result.succeed(emptyDocument(document) ? null : document.toString());
    }
    document.setIn([...CODEX_FIELD], value);
    return Result.succeed(document.toString());
  },
};

const OPENCODE_FIELD = ["metadata", "opencode/autoinvoke"] as const;

const opencodeDocumentResult = (
  frontmatter: string,
  path: string,
): Result.Result<Document, HarnessMetadataInvalid> => {
  const parsed = claudeDocumentResult(frontmatter, path);
  if (Result.isFailure(parsed)) return parsed;
  const metadata = parsed.success.get("metadata", true);
  return metadata === undefined || isMap(metadata)
    ? parsed
    : Result.fail(new HarnessMetadataInvalid({ path, kind: "OpenCode metadata" }));
};

/**
 * OpenCode V2 reads `opencode/autoinvoke` from the portable Agent Skills metadata map. V1
 * accepts and ignores the extension, so projection is version-independent even though enforcement
 * is not. Strings keep the metadata map valid for other Agent Skills consumers.
 */
const opencodeAdapter: InvocationMetadataAdapter = {
  harness: "opencode",
  field: "metadata.opencode/autoinvoke",
  file: "SKILL.md",
  required: true,
  read(text, path) {
    if (text === undefined) return Result.succeed(undefined);
    const match = text.match(CLAUDE_FRONTMATTER);
    if (!match) return Result.succeed(undefined);
    const parsed = claudeDocumentResult(match[1], path);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const metadata = parsed.success.get("metadata", true);
    if (!isMap(metadata)) return Result.succeed(undefined);
    const value = parsed.success.getIn([...OPENCODE_FIELD]);
    if (typeof value === "boolean") return Result.succeed(value);
    if (typeof value !== "string") return Result.succeed(undefined);
    const normalized = value.toLowerCase();
    return Result.succeed(
      normalized === "true" ? true : normalized === "false" ? false : undefined,
    );
  },
  write(text, value, path) {
    const body = text ?? "";
    const newline = body.includes("\r\n") ? "\r\n" : "\n";
    const match = body.match(CLAUDE_FRONTMATTER);
    if (!match)
      return Result.succeed(
        value === undefined
          ? body
          : `---${newline}metadata:${newline}  opencode/autoinvoke: "${value}"${newline}---${newline}${body}`,
      );
    const parsed = opencodeDocumentResult(match[1], path);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const document = parsed.success;
    if (value === undefined) {
      if (document.getIn([...OPENCODE_FIELD]) === undefined) return Result.succeed(body);
      document.deleteIn([...OPENCODE_FIELD]);
      const metadata = document.get("metadata", true);
      if (isMap(metadata) && metadata.items.length === 0) document.delete("metadata");
    } else document.setIn([...OPENCODE_FIELD], String(value));
    const serialized = document.toString({ lineWidth: 0 }).replace(/\n/g, newline);
    return Result.succeed(
      `---${newline}${emptyDocument(document) ? "" : serialized}---${body.slice(match[0].length)}`,
    );
  },
};

const DEVIN_FIELD = "triggers";
const DEVIN_MODEL_TRIGGER = "model";
const DEVIN_USER_TRIGGER = "user";

/**
 * Devin reads `triggers` from the Skill's own frontmatter: `["user", "model"]` lets Devin choose
 * the Skill on its own, `["user"]` restricts it to explicit invocation.
 * See https://docs.devin.ai/product-guides/skills.
 */
const devinAdapter: InvocationMetadataAdapter = {
  harness: "devin",
  field: DEVIN_FIELD,
  file: "SKILL.md",
  required: true,
  read(text, path) {
    if (text === undefined) return Result.succeed(undefined);
    const match = text.match(CLAUDE_FRONTMATTER);
    if (!match) return Result.succeed(undefined);
    const parsed = claudeDocumentResult(match[1], path);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const value = parsed.success.get(DEVIN_FIELD, true) as { toJSON?: () => unknown } | undefined;
    const triggers = value?.toJSON?.() ?? value;
    if (!Array.isArray(triggers)) return Result.succeed(undefined);
    return Result.succeed(triggers.includes(DEVIN_MODEL_TRIGGER));
  },
  write(text, value, path) {
    const body = text ?? "";
    // `host-policy` defers to Devin, and Devin's default is whatever `triggers` already says.
    if (value === undefined) return Result.succeed(body);
    const triggers = value ? [DEVIN_USER_TRIGGER, DEVIN_MODEL_TRIGGER] : [DEVIN_USER_TRIGGER];
    const newline = body.includes("\r\n") ? "\r\n" : "\n";
    const match = body.match(CLAUDE_FRONTMATTER);
    if (!match)
      return Result.succeed(
        `---${newline}${DEVIN_FIELD}: [${triggers.join(", ")}]${newline}---${newline}${body}`,
      );
    const parsed = claudeDocumentResult(match[1], path);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const document = parsed.success;
    document.set(DEVIN_FIELD, document.createNode(triggers, { flow: true }));
    const serialized = document.toString({ lineWidth: 0 }).replace(/\n/g, newline);
    return Result.succeed(`---${newline}${serialized}---${body.slice(match[0].length)}`);
  },
};

export const invocationMetadataAdapters: Record<InvocationHarness, InvocationMetadataAdapter> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  devin: devinAdapter,
};
