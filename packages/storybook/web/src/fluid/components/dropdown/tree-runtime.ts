import { Effect, Queue, Schema, Stream } from 'effect';
import { Mount } from 'foldkit';
import { Menu } from '@foldkit/ui';
import { Message } from './tree-state';
import { inSubmenuCorridor, type Point } from './submenu-geometry';
type RuntimeMessage = Exclude<Message, { readonly _tag: 'Search' }>;

export const TreeMounted = Mount.defineStream('Dropdown.Tree', {
  args: { id: Schema.String },
  messages: [Message.Behavior, Message.OpenedSubmenu, Message.ClosedSubmenu, Message.Dismissed],
  execute: ({ element, id }) =>
    Stream.callback<RuntimeMessage>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (!(element instanceof HTMLElement)) return () => {};
          const emit = (message: RuntimeMessage) => Queue.offerUnsafe(queue, message);
          const panels = () =>
            [...document.querySelectorAll<HTMLElement>('[data-menu-tree]')].filter(
              (panel) => panel.dataset.menuTree === id && !panel.hasAttribute('data-leave'),
            );
          const owned = (target: EventTarget | null): HTMLElement | undefined => {
            const panel =
              target instanceof Element ? target.closest<HTMLElement>('[data-menu-tree]') : null;
            return panel?.dataset.menuTree === id ? panel : undefined;
          };
          const pathOf = (panel: HTMLElement) =>
            panel.dataset.menuPath ? panel.dataset.menuPath.split('.').map(Number) : [];
          const origins = new Map<string, Point>();
          let openTimer: ReturnType<typeof setTimeout> | undefined,
            handoff: ReturnType<typeof setTimeout> | undefined;
          let hovered: HTMLElement | undefined;
          const clearTimers = () => {
            clearTimeout(openTimer);
            clearTimeout(handoff);
            openTimer = undefined;
            handoff = undefined;
          };
          const corridor = (panel: HTMLElement, point: Point) => {
            const held = panel.dataset.heldIndex,
              key = panel.dataset.menuPath ?? '';
            if (held === undefined) return false;
            const child = panels().find(
              (child) =>
                child.dataset.menuPath &&
                child.dataset.menuParent === key &&
                child.dataset.menuParentIndex === held,
            );
            const origin = origins.get(key);
            return (
              !!child && !!origin && inSubmenuCorridor(point, origin, child.getBoundingClientRect())
            );
          };
          const move = (event: PointerEvent) => {
            if (event.pointerType === 'touch') return;
            const panel = owned(event.target),
              point = { x: event.clientX, y: event.clientY };
            if (!panel) {
              if (panels().some((panel) => corridor(panel, point)))
                event.stopImmediatePropagation();
              return;
            }
            const row =
              event.target instanceof Element
                ? (event.target.closest<HTMLElement>('.ff-popup-row') ?? undefined)
                : undefined;
            if (
              !row ||
              row.closest('[data-menu-tree]') !== panel ||
              row.getAttribute('aria-disabled') === 'true'
            )
              return;
            const key = panel.dataset.menuPath ?? '',
              index = Number(row.dataset.dropdownIndex),
              held = panel.dataset.heldIndex;
            if (held !== undefined && Number(held) !== index && corridor(panel, point)) {
              event.stopImmediatePropagation();
              clearTimeout(handoff);
              handoff = setTimeout(
                () =>
                  emit(
                    Message.Behavior({
                      path: pathOf(panel),
                      message: Menu.Message.ActivatedItem({ index, activationTrigger: 'Pointer' }),
                    }),
                  ),
                160,
              );
              return;
            }
            clearTimeout(handoff);
            if (held !== undefined && Number(held) === index) origins.set(key, point);
            if (row === hovered) return;
            clearTimeout(openTimer);
            hovered = row;
            if (row.hasAttribute('data-submenu-trigger')) {
              origins.set(key, point);
              openTimer = setTimeout(() => {
                if (hovered === row && row.isConnected && !panel.hasAttribute('data-leave'))
                  emit(Message.OpenedSubmenu({ path: pathOf(panel), index, keyboard: false }));
              }, 100);
            }
          };
          const leave = (event: PointerEvent) => {
            const panel = owned(event.target);
            if (!panel || panel.dataset.heldIndex === undefined) return;
            if (
              owned(event.relatedTarget) ||
              corridor(panel, { x: event.clientX, y: event.clientY })
            )
              event.stopImmediatePropagation();
          };
          const key = (event: KeyboardEvent) => {
            const panel = owned(event.target);
            if (!panel) return;
            const path = pathOf(panel),
              rtl = panel.dataset.direction === 'rtl';
            if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft') && path.length) {
              event.preventDefault();
              event.stopImmediatePropagation();
              clearTimers();
              emit(Message.ClosedSubmenu({ path }));
            } else if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) {
              const row = panel.querySelector<HTMLElement>(
                '.ff-popup-row[data-active][data-submenu-trigger]',
              );
              if (row) {
                event.preventDefault();
                event.stopImmediatePropagation();
                clearTimers();
                emit(
                  Message.OpenedSubmenu({
                    path,
                    index: Number(row.dataset.dropdownIndex),
                    keyboard: true,
                  }),
                );
              }
            }
          };
          const blur = (event: FocusEvent) => {
            if (
              owned(event.target) &&
              (owned(event.relatedTarget) ||
                (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)))
            )
              event.stopImmediatePropagation();
          };
          const focused = (event: FocusEvent) => {
            if (
              !owned(event.target) &&
              !(event.target instanceof Node && element.contains(event.target)) &&
              panels().length
            ) {
              clearTimers();
              emit(Message.Dismissed());
            }
          };
          document.addEventListener('pointermove', move, true);
          document.addEventListener('pointerleave', leave, true);
          document.addEventListener('keydown', key, true);
          document.addEventListener('blur', blur, true);
          document.addEventListener('focusin', focused, true);
          return () => {
            clearTimers();
            document.removeEventListener('pointermove', move, true);
            document.removeEventListener('pointerleave', leave, true);
            document.removeEventListener('keydown', key, true);
            document.removeEventListener('blur', blur, true);
            document.removeEventListener('focusin', focused, true);
          };
        }),
        (dispose) => Effect.sync(dispose),
      ).pipe(Effect.andThen(Effect.never)),
    ),
});
