import type { SourceDiscoveryDiagnostic } from "@smolai/skit-core/library/source";
import { sourceDiagnostic } from "../plugin-failures.js";
import { Block } from "../../terminal/blocks.js";

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What a Source said about its own files, one warning per path. */
export const sourceDiagnostics = (diagnostics?: readonly SourceDiscoveryDiagnostic[]) =>
  (diagnostics ?? []).map((diagnostic) =>
    Block.Status({
      tone: "warn",
      text: [{ dim: diagnostic.path }, `: ${sourceDiagnostic(diagnostic)}`],
    }),
  );
