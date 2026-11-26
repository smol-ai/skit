import { Effect, Schema } from 'effect';
import { Mount } from 'foldkit';
import { animate, type AnimationPlaybackControls } from 'motion';
import { mountHover } from '../../fluid-hover/engine';
import { mountScrollArea } from '../scroll-area';
import { mountSelections } from '../selection-backgrounds/runtime';
import '../../fluid-hover/styles.css';
import '../scroll-area/styles.css';
import '../list-focus/styles.css';
import './styles.css';

/** Shared popup projection. The enclosing Foldkit UI primitive owns semantics,
 * positioning, portals, dismissal, keyboard navigation, and animation lifetime. */
export const Mounted = Mount.define('Popup.Visuals', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const root = element.closest<HTMLElement>('.ff-popup'),
          viewport = element;
        if (!root) return () => {};
        const focusOwner = root.dataset.focusOwner
          ? document.getElementById(root.dataset.focusOwner)
          : undefined;
        root.dataset.slot = 'scroll-area';
        root.dataset.scrollOrientation = 'vertical';
        root.dataset.radius ??= 'rounded';
        viewport.dataset.radius = root.dataset.radius;
        viewport.dataset.slot = 'scroll-area-viewport';
        viewport.classList.add('base-ui-disable-scrollbar');
        const bar = document.createElement('div'),
          thumb = document.createElement('div');
        bar.className = 'ff-scrollbar';
        bar.dataset.slot = 'scroll-area-scrollbar';
        bar.dataset.orientation = 'vertical';
        bar.setAttribute('aria-hidden', 'true');
        thumb.className = 'ff-scroll-thumb';
        thumb.dataset.slot = 'scroll-area-thumb';
        bar.append(thumb);
        root.append(bar);
        const scroll = mountScrollArea(root, { manageAria: false });
        const rowSelector =
          '[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]';
        const rows = () => [...viewport.querySelectorAll<HTMLElement>(rowSelector)];
        const multiple = root.dataset.selection === 'multiple';
        const selections = multiple ? mountSelections(viewport, rows) : () => {};
        const hover = mountHover(viewport, {
          itemSelector: rowSelector,
          axis: 'y',
          nearest: false,
          keyboardNavigation: false,
          followLayout: true,
          radius: () => root.dataset.radius === 'sharp' ? '1px' : '8px',
        });
        const selection = document.createElement('div'),
          ring = document.createElement('div');
        selection.className = 'ff-popup-selection';
        ring.className = 'ff-list-focus';
        for (const layer of [selection, ring]) {
          layer.setAttribute('aria-hidden', 'true');
          layer.hidden = true;
          viewport.prepend(layer);
        }
        let selectedMotion: AnimationPlaybackControls | undefined,
          focusMotion: AnimationPlaybackControls | undefined,
          keyboard = false;
        const reduced = matchMedia('(prefers-reduced-motion: reduce)');
        const geometries = new Map<HTMLElement, string>();
        const place = (layer: HTMLElement, row: HTMLElement | undefined, focused: boolean) => {
          const previous = focused ? focusMotion : selectedMotion;
          if (!row) {
            previous?.stop();
            geometries.delete(layer);
            layer.hidden = true;
            return;
          }
          const outset = focused ? 2 : 0,
            geometry = {
              left: row.offsetLeft - outset,
              top: row.offsetTop - outset,
              width: row.offsetWidth + outset * 2,
              height: row.offsetHeight + outset * 2,
            };
          const key = `${geometry.left},${geometry.top},${geometry.width},${geometry.height}`;
          if (!layer.hidden && geometries.get(layer) === key) return;
          geometries.set(layer, key);
          previous?.stop();
          if (layer.hidden || reduced.matches)
            Object.assign(layer.style, {
              left: `${geometry.left}px`,
              top: `${geometry.top}px`,
              width: `${geometry.width}px`,
              height: `${geometry.height}px`,
            });
          else {
            const motion = animate(layer, geometry, {
              type: 'spring',
              duration: focused ? 0.08 : 0.16,
              bounce: 0,
            });
            if (focused) focusMotion = motion;
            else selectedMotion = motion;
          }
          layer.hidden = false;
        };
        const sync = () => {
          viewport.dataset.radius = root.dataset.radius;
          const items = rows();
          const focused = items.find(
            (row) => row === document.activeElement && row.matches(':focus-visible'),
          );
          const highlighted =
            root.dataset.heldIndex === undefined
              ? items.find((row) => row.hasAttribute('data-active'))
              : items[Number(root.dataset.heldIndex)];
          const ownsFocus =
            root.contains(document.activeElement) || focusOwner === document.activeElement;
          const keyboardNavigation =
            root.dataset.keyboardNavigation === undefined
              ? keyboard
              : root.dataset.keyboardNavigation === 'true';
          const active = ownsFocus && keyboardNavigation ? (highlighted ?? focused) : focused;
          place(
            selection,
            multiple
              ? undefined
              : items.find(
                  (row) =>
                    row.getAttribute('aria-selected') === 'true' ||
                    row.getAttribute('aria-checked') === 'true',
                ),
            false,
          );
          // Combobox keeps focus in the input and marks its target with the
          // hover surface; a second focus ring belongs only to focused rows.
          place(ring, focusOwner?.getAttribute('role') === 'combobox' ? undefined : active, true);
          const hoverRow = highlighted ?? focused;
          if (hoverRow) {
            const rect = hoverRow.getBoundingClientRect();
            hover.move(rect.left + rect.width / 2, rect.top + rect.height / 2, hoverRow);
          } else if (
            document.activeElement?.getAttribute('role') === 'searchbox' &&
            root.contains(document.activeElement)
          )
            hover.leave();
        };
        const key = (event: KeyboardEvent) => {
          if (
            [
              'ArrowDown',
              'ArrowUp',
              'ArrowLeft',
              'ArrowRight',
              'Home',
              'End',
              'PageUp',
              'PageDown',
              'Tab',
            ].includes(event.key)
          ) {
            keyboard = true;
            sync();
          }
        };
        const pointer = () => {
          keyboard = false;
          sync();
        };
        const observer = new MutationObserver(sync);
        observer.observe(viewport, {
          childList: true,
          attributes: true,
          subtree: true,
          attributeFilter: ['aria-selected', 'aria-checked', 'data-active', 'data-held-index'],
        });
        observer.observe(root, { attributes: true, attributeFilter: ['data-keyboard-navigation','data-radius'] });
        const resize = new ResizeObserver(sync);
        resize.observe(viewport);
        for (const row of rows()) resize.observe(row);
        root.addEventListener('keydown', key, true);
        root.addEventListener('pointermove', pointer, true);
        root.addEventListener('focusin', sync);
        root.addEventListener('focusout', sync);
        focusOwner?.addEventListener('keydown', key, true);
        focusOwner?.addEventListener('focusin', sync);
        focusOwner?.addEventListener('focusout', sync);
        sync();
        return () => {
          observer.disconnect();
          resize.disconnect();
          root.removeEventListener('keydown', key, true);
          root.removeEventListener('pointermove', pointer, true);
          root.removeEventListener('focusin', sync);
          root.removeEventListener('focusout', sync);
          focusOwner?.removeEventListener('keydown', key, true);
          focusOwner?.removeEventListener('focusin', sync);
          focusOwner?.removeEventListener('focusout', sync);
          selectedMotion?.stop();
          focusMotion?.stop();
          hover.dispose();
          selections();
          scroll();
          selection.remove();
          ring.remove();
          bar.remove();
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.andThen(Effect.never)),
});

export { rowContent } from './row';
