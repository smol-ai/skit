import { Effect, Queue, Stream } from 'effect';
import { Mount } from 'foldkit';
import { animate, type AnimationPlaybackControls } from 'motion';
import { mountHover } from '../../fluid-hover/engine';

import { Message } from './messages';
type RuntimeMessage = Extract<Message, { readonly _tag: 'Hovered' }>;

const fast = { type: 'spring' as const, duration: 0.08, bounce: 0 };
const moderate = { type: 'spring' as const, duration: 0.16, bounce: 0 };

/** Visual projection only. The model owns the highlight; this draws the shared
 * fluid-hover fill on it, reports pointer hovers, keeps keyboard moves centred
 * in the viewport, and springs the panel to its rows' height. */
export const Mounted = Mount.defineStream('CommandMenu.Visuals', {
  messages: [Message.Hovered],
  execute: ({ element }) =>
    Stream.callback<RuntimeMessage>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (!(element instanceof HTMLElement)) return () => {};
          const root = element,
            frame = root.querySelector<HTMLElement>('.ff-command-frame'),
            column = root.querySelector<HTMLElement>('.ff-command-column'),
            list = root.querySelector<HTMLElement>('.ff-command-list'),
            viewport = list?.closest<HTMLElement>('[data-slot=scroll-area-viewport]');
          if (!frame || !column || !list || !viewport) return () => {};
          const reduced = matchMedia('(prefers-reduced-motion: reduce)');
          // The engine settles a pick on the next frame, so a programmatic move
          // could report after a later keypress; only picks that follow a real
          // pointer move are reported.
          let fromPointer = false,
            scrollMotion: AnimationPlaybackControls | undefined,
            heightMotion: AnimationPlaybackControls | undefined,
            height: number | undefined,
            shownHeight = 0;
          const hover = mountHover(list, {
            itemSelector: '[role=option]',
            axis: 'y',
            nearest: false,
            keyboardNavigation: false,
            focusHighlight: false,
            followLayout: true,
            radius: () => (root.dataset.radius === 'sharp' ? '1px' : '8px'),
            onPick: (index) => {
              if (!fromPointer || index === null) return;
              fromPointer = false;
              const row = hover.items[index];
              const value = row?.getAttribute('data-fluid-hover-index');
              if (value !== null && value !== undefined)
                Queue.offerUnsafe(queue, Message.Hovered({ index: Number(value) }));
            },
          });
          const activeRow = () => list.querySelector<HTMLElement>('[role=option][data-active]');
          const sync = () => {
            const row = activeRow();
            fromPointer = false;
            if (row) {
              const rect = row.getBoundingClientRect();
              hover.move(rect.left + rect.width / 2, rect.top + rect.height / 2, row);
            } else hover.leave();
          };
          const pointer = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') fromPointer = true;
          };
          list.addEventListener('pointermove', pointer, true);
          const scrollTo = (mode: 'center' | 'top') => {
            scrollMotion?.stop();
            scrollMotion = undefined;
            const row = activeRow();
            const index = Number(row?.dataset.fluidHoverIndex ?? 0);
            if (mode === 'top' || !row || index === 0) {
              viewport.scrollTop = 0;
              return;
            }
            // Offsets, not rects, so a transformed ancestor cannot skew the target.
            const top = row.offsetTop + list.offsetTop;
            const target = Math.max(
              0,
              Math.min(
                top + row.offsetHeight / 2 - viewport.clientHeight / 2,
                viewport.scrollHeight - viewport.clientHeight,
              ),
            );
            if (reduced.matches) viewport.scrollTop = target;
            else
              scrollMotion = animate(viewport.scrollTop, target, {
                ...fast,
                onUpdate: (value) => {
                  viewport.scrollTop = value;
                },
              });
          };
          // No results keeps the height the last results showed, so the message
          // sits where the rows were and the panel does not jump per keystroke.
          const holdEmptyHeight = () => {
            if (list.hasAttribute('data-empty')) {
              list.style.minHeight = shownHeight ? `${shownHeight}px` : '';
              return;
            }
            list.style.minHeight = '';
            shownHeight = Math.min(list.offsetHeight, viewport.clientHeight || Infinity);
          };
          const resize = () => {
            const next = column.offsetHeight;
            if (height === undefined || reduced.matches) {
              heightMotion?.stop();
              frame.style.height = `${next}px`;
            } else if (next !== height) {
              heightMotion?.stop();
              heightMotion = animate(frame, { height: `${next}px` }, moderate);
            }
            height = next;
          };
          let moves = root.dataset.moves,
            rowsKey = root.dataset.rowsKey;
          const observer = new MutationObserver(() => {
            holdEmptyHeight();
            if (root.dataset.rowsKey !== rowsKey) {
              rowsKey = root.dataset.rowsKey;
              scrollTo('top');
            } else if (root.dataset.moves !== moves && root.dataset.activeSource === 'keyboard')
              scrollTo('center');
            moves = root.dataset.moves;
            sync();
          });
          observer.observe(root, {
            attributes: true,
            attributeFilter: ['data-moves', 'data-rows-key', 'data-active-source', 'data-radius'],
          });
          observer.observe(list, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['data-active', 'data-empty'],
          });
          const heights = new ResizeObserver(resize);
          heights.observe(column);
          // The pointer leaving the list keeps the highlight where the model has
          // it, so Enter still has a target.
          const leave = () => queueMicrotask(sync);
          // A row or tab press must not take focus from the field.
          const keepFocus = (event: MouseEvent) => {
            if (
              event.target instanceof Element &&
              event.target.closest('[role=option],[data-command-keep-focus]')
            )
              event.preventDefault();
          };
          // Keys inside an IME composition belong to the composer.
          const compose = (event: KeyboardEvent) => {
            if (event.isComposing || event.keyCode === 229) event.stopPropagation();
          };
          list.addEventListener('pointerleave', leave);
          root.addEventListener('mousedown', keepFocus);
          root.addEventListener('keydown', compose, true);
          resize();
          holdEmptyHeight();
          sync();
          return () => {
            observer.disconnect();
            heights.disconnect();
            list.removeEventListener('pointerleave', leave);
            list.removeEventListener('pointermove', pointer, true);
            root.removeEventListener('mousedown', keepFocus);
            root.removeEventListener('keydown', compose, true);
            scrollMotion?.stop();
            heightMotion?.stop();
            hover.dispose();
            frame.style.removeProperty('height');
          };
        }),
        (cleanup) => Effect.sync(cleanup),
      ),
    ),
});
