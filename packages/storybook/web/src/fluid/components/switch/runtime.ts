import { Effect, Schema, Stream, Queue } from 'effect';
import { defineMessageUnion } from 'foldkit/message';
import { Mount } from 'foldkit';
import { animate, type AnimationPlaybackControls } from 'motion';
import { dragChecked, dragPosition, metrics } from './geometry';

const Message = defineMessageUnion({ Dragged: { checked: Schema.Boolean } });

export function mountSwitch(root: HTMLElement, onToggle: (checked: boolean) => void): () => void {
  const thumb = root.querySelector<HTMLElement>('.ff-switch-thumb');
  if (!thumb) return () => {};
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let animation: AnimationPlaybackControls | undefined;
  let hovered = false,
    pressed = false,
    dragged = false,
    suppressClick = false;
  let start: { id: number; x: number; origin: number } | undefined;
  let clearFrame = 0;
  const checked = () => root.getAttribute('aria-checked') === 'true';
  const compact = () => root.dataset.size === 'compact';
  const interactive = () => !root.matches(':disabled,[data-disabled],[data-readonly]');
  const position = () => new DOMMatrixReadOnly(getComputedStyle(thumb).transform).m41;
  const sync = (initial = false) => {
    if (dragged) return;
    const m = metrics(compact());
    const width = m.thumb + (pressed ? m.extend : hovered ? 2 : 0);
    const x = checked() ? m.track - 2 - width : 2;
    const height = m.thumb - (pressed ? m.shrink : 0);
    const y = 2 + (pressed ? m.shrink / 2 : 0);
    animation?.stop();
    if (initial || reduced.matches) {
      Object.assign(thumb.style, {
        transform: `translateX(${x}px) translateY(${y}px)`,
        width: `${width}px`,
        height: `${height}px`,
      });
    } else
      animation = animate(
        thumb,
        { x, y, width, height },
        { type: 'spring', duration: 0.16, bounce: 0 },
      );
  };
  const enter = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && interactive()) {
      hovered = true;
      root.dataset.hovered = '';
      sync();
    }
  };
  const leave = () => {
    hovered = false;
    delete root.dataset.hovered;
    sync();
  };
  const down = (e: PointerEvent) => {
    if (!interactive() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    start = { id: e.pointerId, x: e.clientX, origin: position() };
    pressed = true;
    dragged = false;
    suppressClick = false;
    root.setPointerCapture(e.pointerId);
    sync();
  };
  const move = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const delta = e.clientX - start.x;
    if (!dragged && Math.abs(delta) < 2) return;
    dragged = true;
    animation?.stop();
    const m = metrics(compact());
    Object.assign(thumb.style, {
      transform: `translateX(${dragPosition(start.origin, delta, compact())}px) translateY(${2 + m.shrink / 2}px)`,
      width: `${m.thumb + m.extend}px`,
      height: `${m.thumb - m.shrink}px`,
    });
  };
  const finish = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const wasDragged = dragged;
    const next = dragChecked(position(), compact());
    start = undefined;
    pressed = false;
    dragged = false;
    if (wasDragged) {
      suppressClick = true;
      cancelAnimationFrame(clearFrame);
      clearFrame = requestAnimationFrame(() => {
        suppressClick = false;
      });
      if (e.type === 'pointerup' && next !== checked() && interactive()) onToggle(next);
    }
    sync();
  };
  const click = (e: MouseEvent) => {
    if (suppressClick) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  const observer = new MutationObserver(() => {
    if (!interactive()) {
      start = undefined;
      pressed = false;
      dragged = false;
      leave();
    }
    sync();
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: ['aria-checked', 'data-size', 'disabled', 'data-readonly'],
  });
  root.addEventListener('pointerenter', enter);
  root.addEventListener('pointerleave', leave);
  root.addEventListener('pointerdown', down);
  root.ownerDocument.addEventListener('pointermove', move, true);
  root.ownerDocument.addEventListener('pointerup', finish, true);
  root.ownerDocument.addEventListener('pointercancel', finish, true);
  root.addEventListener('lostpointercapture', finish);
  // The release click may target an ancestor when the drag ends outside the
  // row. Swallow it before page handlers can dismiss or rerender the control.
  root.ownerDocument.addEventListener('click', click, true);
  sync(true);
  return () => {
    animation?.stop();
    observer.disconnect();
    cancelAnimationFrame(clearFrame);
    root.removeEventListener('pointerenter', enter);
    root.removeEventListener('pointerleave', leave);
    root.removeEventListener('pointerdown', down);
    root.ownerDocument.removeEventListener('pointermove', move, true);
    root.ownerDocument.removeEventListener('pointerup', finish, true);
    root.ownerDocument.removeEventListener('pointercancel', finish, true);
    root.removeEventListener('lostpointercapture', finish);
    root.ownerDocument.removeEventListener('click', click, true);
  };
}

export const Mounted = Mount.defineStream('Switch.Mount', {
  messages: [Message.Dragged],
  execute: ({ element }) =>
    Stream.callback<typeof Message.Dragged.Type>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          element instanceof HTMLElement
            ? mountSwitch(element, (checked) => {
                Queue.offerUnsafe(queue, Message.Dragged({ checked }));
              })
            : () => {},
        ),
        (dispose) => Effect.sync(dispose),
      ).pipe(Effect.andThen(Effect.never)),
    ),
});
