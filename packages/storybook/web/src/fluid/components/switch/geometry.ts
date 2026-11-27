export const metrics = (compact: boolean) =>
  compact
    ? { track: 28, thumb: 12, extend: 3, shrink: 3 }
    : { track: 34, thumb: 16, extend: 4, shrink: 4 };

export function dragPosition(origin: number, delta: number, compact: boolean): number {
  const m = metrics(compact);
  return Math.max(2, Math.min(m.track - 2 - m.thumb - m.extend, origin + delta));
}

export function dragChecked(x: number, compact: boolean): boolean {
  const m = metrics(compact);
  return x > (2 + m.track - 2 - m.thumb - m.extend) / 2;
}
