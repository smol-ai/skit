/** The consumer owns item values; this only proposes a missing, trimmed label. */
export function createCandidate(
  items: readonly { readonly label: string }[],
  query: string,
  foldCase: (value: string) => string = (value) => value.toLowerCase(),
): string | undefined {
  const value = query.trim();
  return value && !items.some((item) => foldCase(item.label) === foldCase(value))
    ? value
    : undefined;
}
