import { Effect, Schema } from 'effect';
import { Mount } from 'foldkit';
/** Native scrolling remains the source of truth. The Foldkit-rendered tracks
 * project that scroll position and handle pointer capture for thumb dragging. */
export function mountScrollArea(
  root: HTMLElement,
  options: { readonly manageAria?: boolean } = {},
) {
  const viewport = [...root.querySelectorAll<HTMLElement>('[data-slot=scroll-area-viewport]')].find(
    (el) => el.closest('[data-slot=scroll-area]') === root,
  );
  if (!viewport) return () => {};
  const bars = [...root.querySelectorAll<HTMLElement>('[data-slot=scroll-area-scrollbar]')].filter(
    (el) => el.closest('[data-slot=scroll-area]') === root,
  );
  let timer: ReturnType<typeof setTimeout> | undefined,
    frame = 0,
    dragging = false;
  const touch = matchMedia('(pointer: coarse)');
  const nativeWasHidden = viewport.classList.contains('base-ui-disable-scrollbar');
  const cleanups: (() => void)[] = [];
  const sync = () => {
    frame = 0;
    const both = root.dataset.scrollOrientation === 'both';
    const isTouch = touch.matches && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    if (nativeWasHidden) viewport.classList.toggle('base-ui-disable-scrollbar', !isTouch);
    if (options.manageAria !== false) {
      // Upstream: a touch scroll area is a "scroll area" group; otherwise
      // the root carries no role (Radix's plain root).
      if (isTouch) {
        root.setAttribute('role', 'group');
        root.setAttribute('aria-roledescription', 'scroll area');
      } else {
        root.removeAttribute('role');
        root.removeAttribute('aria-roledescription');
      }
    }
    root.style.setProperty('--scroll-area-corner-width', both ? '10px' : '0px');
    root.style.setProperty('--scroll-area-corner-height', both ? '10px' : '0px');
    for (const bar of bars) {
      const horizontal = bar.dataset.orientation === 'horizontal',
        thumb = bar.querySelector<HTMLElement>('[data-slot=scroll-area-thumb]');
      if (!thumb) continue;
      const visible = horizontal ? viewport.clientWidth : viewport.clientHeight,
        total = horizontal ? viewport.scrollWidth : viewport.scrollHeight;
      const track = (horizontal ? root.clientWidth : root.clientHeight) - (both ? 10 : 0),
        space = Math.max(0, track - 8);
      // As the primitive sizes it: the whole track times the visible ratio
      // (the thumb's 4px margins are not taken off first).
      const size = Math.max(18, Math.min(space, (track * visible) / Math.max(1, total))),
        offset =
          ((horizontal ? viewport.scrollLeft : viewport.scrollTop) / Math.max(1, total - visible)) *
          Math.max(0, space - size);
      bar.hidden = isTouch || total <= visible + 1;
      bar.style.display = bar.hidden ? 'none' : 'flex';
      bar.dataset.state = 'visible';
      const dimension = horizontal ? 'width' : 'height';
      root.style.setProperty('--scroll-area-thumb-' + dimension, size + 'px');
      root.style.setProperty('--radix-scroll-area-thumb-' + dimension, size + 'px');
      thumb.style[dimension] = size + 'px';
      // The source classes own the cross-axis nudge; the inline transform
      // supplies only travel so Tailwind's independent translate is not doubled.
      thumb.style.transform = horizontal ? `translateX(${offset}px)` : `translateY(${offset}px)`;
      bar.style[horizontal ? 'width' : 'height'] = track + 'px';
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };
  const attr = (name: string, on: boolean) => {
    for (const bar of bars) {
      if (on) {
        bar.setAttribute(name, '');
        bar.setAttribute('data-visible', '');
      } else {
        bar.removeAttribute(name);
        if (!bar.hasAttribute('data-hovering') && !bar.hasAttribute('data-scrolling'))
          bar.removeAttribute('data-visible');
      }
    }
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') attr('data-hovering', true);
  };
  const leave = (e: PointerEvent) => {
    if (!(e.relatedTarget instanceof Node) || !root.contains(e.relatedTarget))
      attr('data-hovering', false);
  };
  const scroll = () => {
    schedule();
    attr('data-scrolling', true);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!dragging) attr('data-scrolling', false);
    }, 100);
  };
  root.addEventListener('pointerenter', move);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerout', leave);
  viewport.addEventListener('scroll', scroll, { passive: true });
  for (const bar of bars) {
    const horizontal = bar.dataset.orientation === 'horizontal',
      thumb = bar.querySelector<HTMLElement>('[data-slot=scroll-area-thumb]');
    if (!thumb) continue;
    let origin = 0,
      initial = 0,
      pointerId: number | undefined;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      pointerId = e.pointerId;
      attr('data-scrolling', true);
      const box = bar.getBoundingClientRect(),
        thumbBox = thumb.getBoundingClientRect();
      const point = horizontal ? e.clientX : e.clientY;
      if (!thumb.contains(e.target instanceof Node ? e.target : null)) {
        const start = horizontal ? box.left : box.top,
          size = horizontal ? thumbBox.width : thumbBox.height,
          space = (horizontal ? bar.clientWidth : bar.clientHeight) - 8 - size;
        const total = horizontal
          ? viewport.scrollWidth - viewport.clientWidth
          : viewport.scrollHeight - viewport.clientHeight;
        const value =
          Math.max(0, Math.min(1, (point - start - 4 - size / 2) / Math.max(1, space))) * total;
        if (horizontal) viewport.scrollLeft = value;
        else viewport.scrollTop = value;
      }
      origin = point;
      initial = horizontal ? viewport.scrollLeft : viewport.scrollTop;
      bar.setPointerCapture(e.pointerId);
      sync();
    };
    const drag = (e: PointerEvent) => {
      if (!dragging || pointerId !== e.pointerId) return;
      const range = horizontal
          ? viewport.scrollWidth - viewport.clientWidth
          : viewport.scrollHeight - viewport.clientHeight,
        space =
          (horizontal
            ? bar.clientWidth - thumb.offsetWidth
            : bar.clientHeight - thumb.offsetHeight) - 8;
      const value =
        initial + (((horizontal ? e.clientX : e.clientY) - origin) * range) / Math.max(1, space);
      if (horizontal) viewport.scrollLeft = value;
      else viewport.scrollTop = value;
    };
    const up = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      dragging = false;
      pointerId = undefined;
      if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
      scroll();
    };
    bar.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', drag);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    cleanups.push(() => {
      bar.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', drag);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    });
  }
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  resize.observe(viewport);
  if (viewport.firstElementChild) resize.observe(viewport.firstElementChild);
  const mutation = new MutationObserver(schedule);
  mutation.observe(viewport, { childList: true, subtree: true });
  touch.addEventListener('change', schedule);
  sync();
  return () => {
    resize.disconnect();
    mutation.disconnect();
    touch.removeEventListener('change', schedule);
    cancelAnimationFrame(frame);
    if (timer) clearTimeout(timer);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerout', leave);
    viewport.removeEventListener('scroll', scroll);
    cleanups.forEach((cleanup) => cleanup());
  };
}
export const ScrollArea = Mount.define('ScrollArea.Mount', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => (element instanceof HTMLElement ? mountScrollArea(element) : () => {})),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.andThen(Effect.never)),
});
