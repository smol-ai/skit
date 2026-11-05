export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export const sourceDiagnosticLines = (diagnostics?: readonly { path: string; message: string }[]) =>
  (diagnostics ?? []).map((diagnostic) => `  ! ${diagnostic.path}: ${diagnostic.message}`);
