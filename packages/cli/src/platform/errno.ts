// Errno inspection for failures that may now arrive wrapped in a PlatformError.
//
// Effect maps errno onto a small set of reason tags and the mapping is lossy: EPERM becomes
// Unknown, and ENOTDIR becomes BadResource rather than NotFound. Code that branches on errno must
// therefore read the original code, not the tag.

export function errnoOf(error: unknown): string | undefined {
  const direct = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof direct === "string") return direct;
  const cause = (error as { reason?: { cause?: unknown } })?.reason?.cause;
  const nested = (cause as NodeJS.ErrnoException | null)?.code;
  return typeof nested === "string" ? nested : undefined;
}

export function isErrno(error: unknown, ...codes: readonly string[]): boolean {
  const code = errnoOf(error);
  return code !== undefined && codes.includes(code);
}
