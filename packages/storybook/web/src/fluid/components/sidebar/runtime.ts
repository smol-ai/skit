import { Effect, Queue, Schema, Stream } from 'effect';
import { Mount } from 'foldkit';
import { animate, type AnimationPlaybackControls } from 'motion';
import { Message, SIDEBAR_COLLAPSE_SLOP, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './state';

/* Upstream's springs: moderate for drawers, peeks and groups; slow for the
 * whole column opening and closing (its exits are plain tweens). */
const moderate = { type: 'spring' as const, duration: 0.16, bounce: 0 };
const moderateExit = { duration: 0.12 };
const slow = { type: 'spring' as const, duration: 0.24, bounce: 0.12 };
const slowExit = { duration: 0.16 };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Upstream's AnimatePresence exits: the view has already dropped `node`,
 * so it goes back in as an inert ghost, tweens out and leaves for good. */
function ghost(
  node: HTMLElement,
  parent: Node,
  before: Node | null,
  keyframes: Parameters<typeof animate>[1],
  transition: Parameters<typeof animate>[2],
) {
  node.inert = true;
  node.style.pointerEvents = 'none';
  parent.insertBefore(node, before && before.parentNode === parent ? before : null);
  const motion = animate(node, keyframes as never, transition);
  void motion.finished.then(
    () => node.remove(),
    () => node.remove(),
  );
  return () => {
    motion.stop();
    node.remove();
  };
}

/** A Mount stream over plain DOM listeners: `setup` wires them and returns
 * the cleanup; `emit` offers one of the Mount's messages. */
const streamed =
  <M>(setup: (element: HTMLElement, emit: (message: M) => void) => () => void) =>
  ({ element }: { readonly element: Element }) =>
    Stream.callback<M>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          element instanceof HTMLElement
            ? setup(element, (message) => Queue.offerUnsafe(queue, message))
            : () => {},
        ),
        (cleanup) => Effect.sync(cleanup),
      ),
    );
type Of<T extends Message['_tag']> = Extract<Message, { readonly _tag: T }>;

/** Mounted providers, for the bare toggle key: only one answers — the
 * innermost containing focus, or with focus outside every provider (or on
 * an element wrapping some) the outermost one, as upstream. */
const providers: HTMLElement[] = [];
const outermost = (list: readonly HTMLElement[]) =>
  list.find((el) => !list.some((other) => other !== el && other.contains(el)));
function answers(root: HTMLElement, target: HTMLElement) {
  if (root.contains(target)) {
    if (providers.some((el) => el !== root && root.contains(el) && el.contains(target)))
      return false;
    return !providers.some((el) => el !== root && target.contains(el));
  }
  const wrapped = providers.filter((el) => target.contains(el));
  if (wrapped.length > 0) return outermost(wrapped) === root;
  if (providers.some((el) => el !== root && el.contains(target))) return false;
  return outermost(providers) === root;
}

export const ProviderMounted = Mount.defineStream('Sidebar.Provider', {
  messages: [Message.MobileDetected, Message.Toggled],
  execute: streamed<Of<'MobileDetected' | 'Toggled'>>((root, emit) => {
    providers.push(root);
    const query = matchMedia(`(max-width: ${Number(root.dataset.breakpoint ?? 768) - 1}px)`);
    const media = () => emit(Message.MobileDetected({ mobile: query.matches }));
    media();
    query.addEventListener('change', media);
    const key = (event: KeyboardEvent) => {
      const shortcut = root.dataset.shortcut;
      if (!shortcut || event.key.toLowerCase() !== shortcut.toLowerCase()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        target.isContentEditable ||
        !answers(root, target)
      )
        return;
      event.preventDefault();
      emit(Message.Toggled());
    };
    window.addEventListener('keydown', key);
    return () => {
      providers.splice(providers.indexOf(root), 1);
      query.removeEventListener('change', media);
      window.removeEventListener('keydown', key);
    };
  }),
});

/** The shell's motion and the peek. The view writes each settled width and
 * panel offset; the runtime springs from the previous one (instantly while
 * a drag holds the pointer). While collapsed with peek on, the edge strip
 * (and a hover-peek trigger) float the rail out after a 150ms intent, and a
 * 250ms leave, Escape or an outside press puts it away. */
export const ShellMounted = Mount.defineStream('Sidebar.Shell', {
  messages: [Message.PeekChanged],
  execute: streamed<Of<'PeekChanged'>>((shell, emit) => {
    const motions: AnimationPlaybackControls[] = [];
    const play = (...args: Parameters<typeof animate>) => {
      const motion = animate(...args);
      motions.push(motion);
      return motion;
    };
    let width = shell.dataset.width ?? '',
      wasOpen = shell.dataset.state === 'expanded',
      wasPeeking = shell.dataset.peeking === 'true',
      card: HTMLElement | null = null,
      dropCard: (() => void) | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const panel = () => shell.querySelector<HTMLElement>(':scope > [data-sidebar=panel]');
    let offset = panel()?.dataset.offset ?? 'none';
    const sync = () => {
      const open = shell.dataset.state === 'expanded';
      const resizing = shell.dataset.resizing === 'true';
      const next = shell.dataset.width ?? width;
      const flipped = open !== wasOpen;
      const transition = reduced()
        ? { duration: 0 }
        : resizing
          ? flipped
            ? open
              ? moderate
              : moderateExit
            : { duration: 0 }
          : shell.dataset.shown === 'true'
            ? slow
            : slowExit;
      /* The view has already written the settled value inline, and Motion
       * only applies its first keyframe on its next frame, so the browser
       * would paint the end state for a frame before snapping back. This
       * observer runs before paint: put the start value back first. */
      if (next !== width) {
        if (width) shell.style.width = width;
        play(shell, { width: [width, next] }, transition);
        width = next;
      }
      const target = panel();
      const nextOffset = target?.dataset.offset ?? 'none';
      if (target && nextOffset !== offset) {
        target.style.transform = offset;
        play(target, { transform: [offset, nextOffset] }, transition);
        offset = nextOffset;
      }
      wasOpen = open;
      const peeking = shell.dataset.peeking === 'true';
      const from = shell.dataset.side === 'right' ? '108%' : '-108%';
      if (peeking && !wasPeeking) {
        dropCard?.();
        dropCard = undefined;
        card = shell.querySelector<HTMLElement>(':scope > [data-sidebar=peek]');
        if (card && !reduced()) play(card, { x: [from, '0%'] }, moderate);
      } else if (!peeking && wasPeeking && card) {
        if (!card.isConnected && !reduced())
          dropCard = ghost(card, shell, null, { x: from }, moderateExit);
        card = null;
      }
      wasPeeking = peeking;
    };
    const observer = new MutationObserver(sync);
    observer.observe(shell, {
      attributes: true,
      attributeFilter: ['data-state', 'data-width', 'data-resizing', 'data-peeking', 'data-offset'],
      subtree: true,
    });
    const children = new MutationObserver(sync);
    children.observe(shell, { childList: true });

    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (peeking: boolean, ms: number) => {
      cancel();
      timer = setTimeout(() => emit(Message.PeekChanged({ peeking })), ms);
    };
    const mode = () => shell.dataset.peek;
    const peeking = () => shell.dataset.peeking === 'true';
    const root = shell.closest<HTMLElement>('[data-slot=sidebar-wrapper]') ?? shell;
    const over = (event: PointerEvent) => {
      if (mode() !== 'hover' || event.pointerType !== 'mouse') return;
      const target = event.target as HTMLElement;
      const strip = target.closest('[data-sidebar=peek-strip]');
      const trigger = target.closest('[data-sidebar=trigger]');
      if ((strip && shell.contains(strip)) || trigger) {
        if (peeking()) cancel();
        else schedule(true, 150);
      }
    };
    const out = (event: PointerEvent) => {
      if (mode() !== 'hover' || peeking()) return;
      const to = event.relatedTarget as Node | null;
      if (!to || !shell.contains(to)) cancel();
    };
    let inside = true;
    const move = (event: PointerEvent) => {
      if (mode() !== 'hover' || !peeking()) return;
      const overlay = shell.querySelector('[data-sidebar=peek]') ?? shell;
      const box = overlay.getBoundingClientRect();
      const within =
        event.clientX >= box.left - 8 &&
        event.clientX <= box.right + 8 &&
        event.clientY >= box.top - 8 &&
        event.clientY <= box.bottom + 8;
      if (within) {
        inside = true;
        cancel();
      } else if (inside) {
        inside = false;
        schedule(false, 250);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && peeking()) emit(Message.PeekChanged({ peeking: false }));
    };
    const press = (event: PointerEvent) => {
      if (peeking() && !shell.contains(event.target as Node))
        emit(Message.PeekChanged({ peeking: false }));
    };
    root.addEventListener('pointerover', over);
    root.addEventListener('pointerout', out);
    document.addEventListener('pointermove', move);
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', press);
    return () => {
      cancel();
      dropCard?.();
      observer.disconnect();
      children.disconnect();
      motions.forEach((motion) => motion.stop());
      root.removeEventListener('pointerover', over);
      root.removeEventListener('pointerout', out);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', press);
    };
  }),
});

/** The grab strip: drag to resize (clamped 160–360px), drag well past the
 * minimum to preview a collapse (dragging back rescues it), click to toggle. */
export const RailMounted = Mount.defineStream('Sidebar.Rail', {
  messages: [Message.Resized, Message.ResizeChanged, Message.OpenSet, Message.Toggled],
  execute: streamed<Of<'Resized' | 'ResizeChanged' | 'OpenSet' | 'Toggled'>>((rail, emit) => {
    let drag:
      | { startX: number; startWidth: number; moved: boolean; collapsed: boolean; id: number }
      | undefined;
    const side = () =>
      rail.closest<HTMLElement>('[data-slot=sidebar]')?.dataset.side === 'right' ? 'right' : 'left';
    const down = (event: PointerEvent) => {
      const shell = rail.closest<HTMLElement>('[data-slot=sidebar]');
      if (!shell || event.button !== 0) return;
      drag = {
        startX: event.clientX,
        startWidth: shell.offsetWidth,
        moved: false,
        collapsed: false,
        id: event.pointerId,
      };
      rail.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        rail.dataset.dragging = '';
        emit(Message.ResizeChanged({ resizing: true }));
      }
      const raw = drag.startWidth + (side() === 'left' ? dx : -dx);
      if (raw < SIDEBAR_MIN_WIDTH - SIDEBAR_COLLAPSE_SLOP) {
        if (!drag.collapsed) {
          drag.collapsed = true;
          emit(Message.Resized({ width: `${SIDEBAR_MIN_WIDTH}px` }));
          emit(Message.OpenSet({ open: false }));
        }
        return;
      }
      if (drag.collapsed) {
        drag.collapsed = false;
        emit(Message.OpenSet({ open: true }));
      }
      const next = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, raw));
      emit(Message.Resized({ width: `${Math.round(next)}px` }));
    };
    const end = (event: PointerEvent, cancelled: boolean) => {
      if (!drag) return;
      const { moved } = drag;
      drag = undefined;
      if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
      delete rail.dataset.dragging;
      if (moved) emit(Message.ResizeChanged({ resizing: false }));
      else if (!cancelled) emit(Message.Toggled());
    };
    const up = (event: PointerEvent) => end(event, false);
    const cancelled = (event: PointerEvent) => end(event, true);
    rail.addEventListener('pointerdown', down);
    rail.addEventListener('pointermove', move);
    rail.addEventListener('pointerup', up);
    rail.addEventListener('pointercancel', cancelled);
    return () => {
      rail.removeEventListener('pointerdown', down);
      rail.removeEventListener('pointermove', move);
      rail.removeEventListener('pointerup', up);
      rail.removeEventListener('pointercancel', cancelled);
    };
  }),
});

/** A collapsible group's body: springs between 0 and its measured height
 * when the group toggles, and snaps when the content resizes underneath
 * (a nested sub-menu), clipping only while it moves. */
export const CollapseMounted = Mount.define('Sidebar.Collapse', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const content = element.firstElementChild as HTMLElement | null;
        let open = element.dataset.open === 'true';
        let height = open ? (content?.offsetHeight ?? 0) : 0;
        let motion: AnimationPlaybackControls | undefined;
        const resize = new ResizeObserver(() => {
          if (open && !motion && content) height = content.offsetHeight;
        });
        if (content) resize.observe(content);
        const observer = new MutationObserver(() => {
          const next = element.dataset.open === 'true';
          if (next === open || !content) return;
          open = next;
          motion?.stop();
          const target = open ? content.offsetHeight : 0;
          element.style.overflow = 'hidden';
          motion = animate(
            element,
            { height: [`${height}px`, `${target}px`], opacity: open ? [0, 1] : [1, 0] },
            reduced() ? { duration: 0 } : open ? moderate : moderateExit,
          );
          motion.finished.then(() => {
            motion = undefined;
            if (!open) return;
            element.style.height = '';
            element.style.overflow = '';
            height = content.offsetHeight;
          });
          height = target;
        });
        observer.observe(element, { attributes: true, attributeFilter: ['data-open'] });
        return () => {
          motion?.stop();
          observer.disconnect();
          resize.disconnect();
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.andThen(Effect.never)),
});

/** The drawer's entrance: slides in from its edge on moderate, takes focus,
 * and gives it back on close. */
export const SheetMounted = Mount.defineStream('Sidebar.Sheet', {
  messages: [Message.MobileOpenSet],
  execute: streamed<Of<'MobileOpenSet'>>((element, emit) => {
    if (!(element instanceof HTMLElement)) return () => {};
    const previous = document.activeElement;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    if (element instanceof HTMLDialogElement) element.showModal();
    const outside = (event: MouseEvent) => {
      const box = element.getBoundingClientRect();
      if (
        event.target === element &&
        (event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom)
      )
        emit(Message.MobileOpenSet({ open: false }));
    };
    element.addEventListener('click', outside);
    const release = () => {
      element.removeEventListener('click', outside);
      if (element instanceof HTMLDialogElement) element.close();
      document.documentElement.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
    const from = element.dataset.side === 'right' ? '100%' : '-100%';
    const motion = animate(element, { x: [from, '0%'] }, reduced() ? { duration: 0 } : moderate);
    const scrim = element.previousElementSibling;
    const fade =
      scrim instanceof HTMLElement
        ? animate(scrim, { opacity: [0, 1] }, { duration: reduced() ? 0 : 0.16 })
        : undefined;
    element.focus();
    return () => {
      motion.stop();
      fade?.stop();

      // The keyed host (scrim + panel) is swapped out whole: a clone of
      // it plays the exit where it stood.
      const host = element.parentElement;
      const parent = host?.parentNode;
      if (!host || !parent || reduced()) {
        release();
        return;
      }
      const copy = host.cloneNode(true) as HTMLElement;
      release();
      const after = host.nextSibling;
      queueMicrotask(() => {
        if (!parent.isConnected || host.isConnected) return;
        const panel = copy.querySelector<HTMLElement>('[data-mobile=true]');
        const shade = copy.querySelector<HTMLElement>('[data-sidebar=scrim]');
        copy.inert = true;
        copy.style.pointerEvents = 'none';
        parent.insertBefore(copy, after && after.parentNode === parent ? after : null);
        const drop = () => copy.remove();
        if (shade) animate(shade, { opacity: 0 }, { duration: 0.12 });
        if (!panel) return drop();
        void animate(panel, { x: from }, moderateExit).finished.then(drop, drop);
      });
    };
  }),
});

/** The stacked callouts' layout: the front card's measured height drives the
 * pile (a banner's height follows the rail's width). Collapsed, cards peek
 * 12px apiece with a 5% scale step, two peeks at most; the inline pile fans
 * out under the pointer, 4px apart. */
export const CalloutStackMounted = Mount.define('Sidebar.CalloutStack', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const stack = element;
        const PEEK = 12,
          SCALE = 0.05,
          GAP = 4,
          MAX = 2;
        let hovered = false,
          first = true;
        const motions: AnimationPlaybackControls[] = [];
        const layout = () => {
          motions.splice(0).forEach((motion) => motion.stop());
          const cards = [...stack.children].filter(
            (child): child is HTMLElement =>
              child instanceof HTMLElement && child.dataset.exiting === undefined,
          );
          const n = cards.length;
          const cardH = cards[0]?.offsetHeight || (stack.dataset.variant === 'banner' ? 180 : 64);
          const expanded = stack.dataset.variant === 'inline' && hovered;
          const height = expanded
            ? n * cardH + Math.max(n - 1, 0) * GAP
            : cardH + Math.min(Math.max(n - 1, 0), MAX) * PEEK;
          const transition = first || reduced() ? { duration: 0 } : moderate;
          motions.push(animate(stack, { height: `${height}px` }, transition));
          cards.forEach((card, i) => {
            const peek = Math.min(i, MAX);
            card.style.zIndex = String(100 - i);
            motions.push(
              animate(
                card,
                expanded
                  ? { y: -i * (cardH + GAP), scale: 1, opacity: 1 }
                  : { y: -peek * PEEK, scale: 1 - peek * SCALE, opacity: i <= MAX ? 1 : 0 },
                transition,
              ),
            );
          });
          first = false;
        };
        const enter = () => {
          hovered = true;
          layout();
        };
        const leave = () => {
          hovered = false;
          layout();
        };
        stack.addEventListener('mouseenter', enter);
        stack.addEventListener('mouseleave', leave);
        // A dismissed card fades and shrinks where it sat (upstream's exit)
        // while the rest close ranks under it.
        const exits: (() => void)[] = [];
        const children = new MutationObserver((records) => {
          if (!reduced())
            for (const record of records)
              record.removedNodes.forEach((node) => {
                if (!(node instanceof HTMLElement) || node.dataset.exiting !== undefined) return;
                node.dataset.exiting = '';
                node.style.zIndex = '101';
                exits.push(
                  ghost(node, stack, stack.firstChild, { scale: 0.9, opacity: 0 }, moderateExit),
                );
              });
          layout();
        });
        children.observe(stack, { childList: true });
        const resize = new ResizeObserver(() => layout());
        const front = stack.firstElementChild;
        if (front) resize.observe(front);
        layout();
        return () => {
          motions.forEach((motion) => motion.stop());
          exits.forEach((drop) => drop());
          children.disconnect();
          resize.disconnect();
          stack.removeEventListener('mouseenter', enter);
          stack.removeEventListener('mouseleave', leave);
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.andThen(Effect.never)),
});
