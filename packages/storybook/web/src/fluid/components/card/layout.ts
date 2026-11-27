export function columns(value = 1): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}
/** Grid edges belong to the preceding card. Suppress each edge touching the
 * hovered or selected card, including the crossing pixel of a right edge. */
export function dividers(
  index: number,
  count: number,
  cols: number,
  active = -1,
  selected = -1,
  divided = true,
) {
  const width = columns(cols),
    col = index % width;
  const touches = (next: number) =>
    [index, next].includes(active) || [index, next].includes(selected);
  return {
    bottom: divided && index + width < count && !touches(index + width),
    right: divided && col < width - 1 && index + 1 < count && !touches(index + 1),
  };
}
