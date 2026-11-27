import { shapeRadius } from '../shape';
import { animate, type AnimationPlaybackControls } from 'motion';
import {
  assignRuns,
  findBoundaries,
  projectBlocks,
  validBoundary,
  type Boundary,
  type Runs,
} from './state';
import type { ItemRect } from '../../fluid-hover/geometry';
import './styles.css';

/** A scoped visual projection. Checked state remains owned by Foldkit. */
export function mountSelections(root: HTMLElement, getRows: () => readonly HTMLElement[]) {
  let ids: Runs = { runs: [], byRow: new Map(), lastId: 0 },
    signature = '';
  let boundaries: Boundary[] = [];
  const timers = new Map<Boundary, ReturnType<typeof setTimeout>>();
  const frames = new Set<number>();
  const nodes = new Map<
    number,
    {
      node: HTMLDivElement;
      animations: AnimationPlaybackControls[];
      exitInstant?: boolean;
      exiting?: boolean;
    }
  >();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const frame = (f: () => void) => {
    const id = requestAnimationFrame(() => {
      frames.delete(id);
      f();
    });
    frames.add(id);
  };
  const paint = () => {
    const rects: ItemRect[] = getRows().map((row) => {
      // Layout coordinates match absolute children and stay independent of transforms.
      // Visual bounds divided by offsetHeight also misread fractional layout as scaling.
      let top = row.offsetTop,
        left = row.offsetLeft,
        ancestor = row.offsetParent;
      while (ancestor instanceof HTMLElement && ancestor !== root && root.contains(ancestor)) {
        top += ancestor.offsetTop + ancestor.clientTop;
        left += ancestor.offsetLeft + ancestor.clientLeft;
        ancestor = ancestor.offsetParent;
      }
      return { top, left, width: row.offsetWidth, height: row.offsetHeight };
    });
    const blocks = projectBlocks(
      ids.runs,
      rects,
      shapeRadius(root.dataset.radius, 8, 16),
      boundaries,
    );
    const active = new Set(blocks.map((b) => b.id));
    for (const b of blocks) {
      let entry = nodes.get(b.id);
      const fresh = !entry;
      if (!entry) {
        const node = document.createElement('div');
        node.className = 'ff-selection-background';
        node.setAttribute('aria-hidden', 'true');
        root.prepend(node);
        entry = { node, animations: [] };
        nodes.set(b.id, entry);
      }
      entry.animations.forEach((a) => a.stop());
      entry.animations = [];
      entry.exiting = false;
      entry.exitInstant = b.exitInstant;
      const corners = (r: readonly [number, number, number, number]) => ({
        borderTopLeftRadius: r[0],
        borderTopRightRadius: r[1],
        borderBottomRightRadius: r[2],
        borderBottomLeftRadius: r[3],
      });
      const geometry = {
        top: b.top,
        left: b.left,
        width: b.width,
        height: b.height,
        opacity: b.opacity ?? 1,
      };
      const set = (values: Record<string, number>) => {
        for (const [key, value] of Object.entries(values))
          (entry!.node.style as unknown as Record<string, string>)[key] =
            key === 'opacity' ? String(value) : `${value}px`;
      };
      if (fresh)
        set({
          ...geometry,
          ...corners(b.enterFrom?.radii ?? b.radii),
          ...(b.enterFrom ? { top: b.enterFrom.top, height: b.enterFrom.height } : {}),
        });
      if (b.instant || reduced.matches || (fresh && !b.enterFrom))
        set({ ...geometry, ...corners(b.radii) });
      else {
        entry.animations.push(
          animate(entry.node, geometry, {
            type: 'spring',
            duration: 0.16,
            bounce: 0,
            opacity: { duration: 0.08 },
          }),
        );
        entry.animations.push(
          animate(entry.node, corners(b.radii), {
            type: 'spring',
            duration: 0.16,
            bounce: 0,
            delay: b.cornerDelay ?? 0,
          }),
        );
      }
    }
    for (const [id, entry] of nodes) {
      if (active.has(id) || entry.exiting) continue;
      entry.exiting = true;
      entry.animations.forEach((a) => a.stop());
      if (entry.exitInstant || reduced.matches) {
        entry.node.remove();
        nodes.delete(id);
      } else {
        const exit = animate(entry.node, { opacity: 0 }, { duration: 0.12 });
        entry.animations = [exit];
        void exit.then(() => {
          if (entry.exiting) {
            entry.node.remove();
            nodes.delete(id);
          }
        });
      }
    }
  };
  const sync = () => {
    const selected = getRows().flatMap((row, i) =>
        row.getAttribute('aria-checked') === 'true' || row.getAttribute('aria-selected') === 'true'
          ? [i]
          : [],
      ),
      next = selected.join(',');
    if (next !== signature) {
      const old = ids;
      ids = assignRuns(selected, ids);
      signature = next;
      boundaries = boundaries.filter((b) => {
        const valid = validBoundary(b, ids.runs);
        if (!valid) {
          clearTimeout(timers.get(b));
          timers.delete(b);
        }
        return valid;
      });
      const found = findBoundaries(old.runs, ids.runs);
      boundaries.push(...found);
      for (const b of found) {
        timers.set(
          b,
          setTimeout(
            () => {
              timers.delete(b);
              if (b.kind === 'merge') {
                b.phase = 'commit';
                paint();
                frame(() => {
                  boundaries = boundaries.filter((x) => x !== b);
                  paint();
                });
              } else {
                boundaries = boundaries.filter((x) => x !== b);
                paint();
              }
            },
            b.kind === 'merge' ? 310 : 240,
          ),
        );
      }
      paint();
      if (found.some((b) => b.kind === 'split'))
        frame(() => {
          found.forEach((b) => {
            if (b.kind === 'split') b.phase = 'diverge';
          });
          paint();
        });
    } else paint();
  };
  const observer = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          record.type === 'attributes' ||
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches('[aria-checked],[aria-selected]') ||
                node.querySelector('[aria-checked],[aria-selected]')),
          ),
      )
    )
      sync();
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-checked', 'aria-selected', 'data-size', 'data-radius'],
  });
  const resize = new ResizeObserver(sync);
  resize.observe(root);
  getRows().forEach((row) => resize.observe(row));
  sync();
  return () => {
    observer.disconnect();
    resize.disconnect();
    timers.forEach(clearTimeout);
    frames.forEach(cancelAnimationFrame);
    nodes.forEach((e) => {
      e.animations.forEach((a) => a.stop());
      e.node.remove();
    });
    nodes.clear();
  };
}
