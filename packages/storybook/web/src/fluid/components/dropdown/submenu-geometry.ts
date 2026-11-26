export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}
/** The pointer's departure point and the near edge of the resolved submenu
 * form a corridor. Works after left/right collision flipping and in RTL. */
export function inSubmenuCorridor(point: Point, origin: Point, child: Rect): boolean {
  const edge = origin.x < child.left ? child.left : child.right;
  if (Math.abs(edge - origin.x) < 1) return false;
  const a = origin,
    b = { x: edge, y: child.top - 8 },
    c = { x: edge, y: child.bottom + 8 };
  const cross = (p: Point, q: Point, r: Point) =>
    (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const d1 = cross(point, a, b),
    d2 = cross(point, b, c),
    d3 = cross(point, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
