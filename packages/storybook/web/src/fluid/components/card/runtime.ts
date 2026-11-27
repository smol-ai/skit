import { shapeRadius } from '../shape';
import { Effect, Schema } from 'effect';
import { Mount } from 'foldkit';
import { mountHover } from '../../fluid-hover/engine';
import { dividers } from './layout';
import '../../fluid-hover/styles.css';
export const Mounted = Mount.define('CardGroup.HoverAndDividers', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const root = element;
        let active = -1;
        const cards = () =>
          [...root.querySelectorAll<HTMLElement>('.ff-card')].filter(
            (card) => card.closest('.ff-card-group') === root,
          );
        const paint = () => {
          const items = cards(),
            cols = Number(root.dataset.columns),
            selected = Number(root.dataset.selectedIndex);
          for (const [index, card] of items.entries()) {
            const edges = dividers(
              index,
              items.length,
              cols,
              active,
              selected,
              root.dataset.separated !== 'true',
            );
            card.dataset.dividerBottom = String(edges.bottom);
            card.dataset.dividerRight = String(edges.right);
          }
        };
        const hover = mountHover(root, {
          itemSelector: '.ff-card[data-clickable=true]',
          ownsItem: (card) => card.closest('.ff-card-group') === root,
          axis: 'xy',
          nearest: false,
          keyboardNavigation: false,
          followLayout: true,
          enabled: () => root.dataset.fluidHover !== 'false',
          radius: () => (`${shapeRadius(root.dataset.radius, 12, 24, 1)}px`),
          onPick: (index) => {
            const target =
              index === null
                ? undefined
                : cards().filter((card) => card.dataset.clickable === 'true')[index];
            active = target ? Number(target.dataset.cardIndex) : -1;
            paint();
          },
        });
        const sync = () => {
          if (root.dataset.fluidHover === 'false') {
            active = -1;
            hover.leave();
          }
          hover.measure();
          paint();
        };
        const observer = new MutationObserver(sync);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            'data-columns',
            'data-selected-index',
            'data-separated',
            'data-fluid-hover',
          ],
        });
        paint();
        return () => {
          observer.disconnect();
          hover.dispose();
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.andThen(Effect.never)),
});
