import { Block, renderBlocks, type Inline } from "./blocks.js";

/** The presentation is semantic; text fields serve the existing JSON and embedded-text callers. */
export interface FailureDescription {
  readonly message: string;
  readonly remediation: string;
  /** Nested owners can explain a cause without repeating its action at each layer. */
  readonly explanation: readonly Block[];
  readonly next: readonly Inline[];
  readonly presentation: readonly Block[];
}

const text = (parts: readonly Inline[], quoteCode: boolean): string =>
  parts
    .map((part) =>
      typeof part === "string"
        ? part
        : "code" in part || "path" in part
          ? quoteCode
            ? `\`${"code" in part ? part.code : part.path}\``
            : "code" in part
              ? part.code
              : part.path
          : "url" in part
            ? part.url
            : "dim" in part
              ? part.dim
              : part.emph,
    )
    .join("");

/** Owners choose the summary, details and action. The terminal chooses their appearance. */
export const describeFailure = ({
  summary,
  details = [],
  next,
}: {
  readonly summary: readonly Inline[];
  readonly details?: readonly Block[];
  readonly next: readonly Inline[];
}): FailureDescription => {
  const explanation = [Block.Status({ tone: "error", text: summary }), ...details];
  return {
    message: [
      text(summary, false),
      ...(details.length ? [renderBlocks(details, { color: false })] : []),
    ].join("\n"),
    remediation: text(next, true),
    explanation,
    next,
    presentation: [
      ...explanation,
      ...(next.length ? [Block.Fields({ rows: [{ label: "Next", value: next }] })] : []),
    ],
  };
};
