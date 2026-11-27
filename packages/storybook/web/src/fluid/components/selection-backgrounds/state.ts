// Geometry and continuity ported from Fluid Functionalism's use-merge-split (MIT).
import type { ItemRect } from '../../fluid-hover/geometry';
export interface Run {
  start: number;
  end: number;
  id: number;
}
export interface Runs {
  runs: Run[];
  byRow: Map<number, number>;
  lastId: number;
}
export function assignRuns(indices: readonly number[], previous: Runs): Runs {
  const spans: { start: number; end: number }[] = [];
  for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
    const last = spans.at(-1);
    if (last && last.end + 1 === index) last.end = index;
    else spans.push({ start: index, end: index });
  }
  let lastId = previous.lastId;
  const byRow = new Map<number, number>(),
    used = new Set<number>();
  const runs = spans.map((span) => {
    let id: number | undefined;
    for (let row = span.start; row <= span.end; row++) {
      const old = previous.byRow.get(row);
      if (old !== undefined && !used.has(old)) {
        id = old;
        break;
      }
    }
    id ??= ++lastId;
    used.add(id);
    for (let row = span.start; row <= span.end; row++) byRow.set(row, id);
    return { ...span, id };
  });
  return { runs, byRow, lastId };
}
export interface Boundary {
  kind: 'merge' | 'split';
  survivorId: number;
  otherId: number;
  gap: number;
  phase: 'converge' | 'commit' | 'splitIn' | 'diverge';
}
function pair(outer: Run, runs: readonly Run[]) {
  const inside = runs.filter((r) => r.start >= outer.start && r.end <= outer.end);
  const [up, lo] = inside;
  return inside.length === 2 && up && lo && lo.start === up.end + 2
    ? { up, lo, gap: up.end + 1 }
    : undefined;
}
export function findBoundaries(previous: readonly Run[], current: readonly Run[]): Boundary[] {
  const result: Boundary[] = [];
  for (const run of current) {
    const p = pair(run, previous);
    if (p && (run.id === p.up.id || run.id === p.lo.id))
      result.push({
        kind: 'merge',
        survivorId: run.id,
        otherId: run.id === p.up.id ? p.lo.id : p.up.id,
        gap: p.gap,
        phase: 'converge',
      });
  }
  for (const run of previous) {
    const p = pair(run, current);
    if (p)
      result.push({
        kind: 'split',
        survivorId: p.up.id,
        otherId: p.lo.id,
        gap: p.gap,
        phase: 'splitIn',
      });
  }
  return result;
}
export function validBoundary(b: Boundary, runs: readonly Run[]): boolean {
  return b.kind === 'merge'
    ? runs.some((r) => r.id === b.survivorId && r.start < b.gap && r.end > b.gap)
    : runs.some((r) => r.id === b.survivorId && r.end === b.gap - 1) &&
        runs.some((r) => r.id === b.otherId && r.start === b.gap + 1);
}
type Radii = [number, number, number, number];
export interface Block extends ItemRect {
  id: number;
  radii: Radii;
  instant?: boolean;
  exitInstant?: boolean;
  cornerDelay?: number;
  opacity?: number;
  enterFrom?: { top: number; height: number; radii: Radii };
}
export function projectBlocks(
  runs: readonly Run[],
  rects: readonly ItemRect[],
  radius: number,
  boundaries: readonly Boundary[],
): Block[] {
  const R = radius,
    blocks: Block[] = [];
  for (const run of runs) {
    const s = rects[run.start],
      e = rects[run.end];
    if (s && e)
      blocks.push({
        id: run.id,
        top: s.top,
        left: Math.min(s.left, e.left),
        width: Math.max(s.width, e.width),
        height: e.top + e.height - s.top,
        radii: [R, R, R, R],
      });
  }
  for (const b of boundaries) {
    const gap = rects[b.gap],
      upper = blocks.find((x) => x.id === b.survivorId);
    if (!gap || !upper) continue;
    const mid = gap.top + gap.height / 2;
    if (b.kind === 'merge') {
      const lower: Block = {
        id: b.otherId,
        top: mid,
        left: upper.left,
        width: upper.width,
        height: upper.top + upper.height - mid,
        radii: [0, 0, R, R],
        exitInstant: true,
      };
      if (b.phase === 'commit') {
        upper.instant = true;
        lower.instant = true;
        lower.opacity = 0;
      } else {
        upper.height = mid - upper.top;
        upper.radii = [R, R, 0, 0];
        upper.cornerDelay = lower.cornerDelay = Math.min(
          0.1,
          0.07 + (mid / Math.max(gap.height, 1)) * 0.002,
        );
        lower.enterFrom = { top: mid, height: lower.height, radii: [R, R, R, R] };
      }
      blocks.push(lower);
    } else if (b.phase === 'splitIn') {
      const lower = blocks.find((x) => x.id === b.otherId);
      if (!lower) continue;
      const bottom = lower.top + lower.height;
      upper.height = mid - upper.top;
      upper.radii = [R, R, 0, 0];
      upper.instant = true;
      lower.top = mid;
      lower.height = bottom - mid;
      lower.radii = [0, 0, R, R];
      lower.instant = true;
      lower.enterFrom = { top: mid, height: lower.height, radii: [0, 0, R, R] };
    }
  }
  return blocks;
}
