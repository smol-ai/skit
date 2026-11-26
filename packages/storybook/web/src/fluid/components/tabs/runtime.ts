import { shapeRadius } from '../shape';
import { Effect, Schema } from 'effect';
import { Mount } from 'foldkit';
import { animate, type AnimationPlaybackControls } from 'motion';
import { mountHover } from '../../fluid-hover/engine';
import { mountListFocus } from '../list-focus';
import '../../fluid-hover/styles.css';

export const Mounted = Mount.define('Tabs.Visuals', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const root = element;
        const tabs = () =>
          [...root.querySelectorAll<HTMLElement>('.ff-tab')].filter(
            (tab) => tab.closest('.ff-tabs-list') === root,
          );
        const hover = mountHover(root, {
          itemSelector: '.ff-tab',
          ownsItem: (tab) => tab.closest('.ff-tabs-list') === root,
          axis: 'x',
          tabs: true,
          nearest: false,
          keyboardNavigation: false,
          followLayout: true,
          radius: () => (`${shapeRadius(root.dataset.radius, 8, 20, 1)}px`),
        });
        const focus = mountListFocus(root, tabs);
        const reduced = matchMedia('(prefers-reduced-motion: reduce)');
        const labels = new Map<
          HTMLElement,
          { shown: boolean; width: number; gap: number; motion?: AnimationPlaybackControls }
        >();
        const sync = () => {
          for (const tab of tabs()) {
            if (tab.dataset.collapseLabel !== 'true') continue;
            const clip = tab.querySelector<HTMLElement>('.ff-tab-label-clip'),
              label = clip?.querySelector<HTMLElement>('.ff-tab-label');
            if (!clip || !label) continue;
            const shown = tab.getAttribute('aria-selected') === 'true',
              width = label.offsetWidth,
              gap = root.dataset.size === 'compact' ? 6 : 8,
              previous = labels.get(clip);
            if (previous?.shown === shown && previous.width === width && previous.gap === gap)
              continue;
            previous?.motion?.stop();
            const target = {
              width: shown ? width : 0,
              marginLeft: shown ? gap : 0,
              opacity: shown ? 1 : 0,
            };
            if (!previous || reduced.matches) {
              Object.assign(clip.style, {
                width: `${target.width}px`,
                marginLeft: `${target.marginLeft}px`,
                opacity: String(target.opacity),
              });
              labels.set(clip, { shown, width, gap });
            } else
              labels.set(clip, {
                shown,
                width,
                gap,
                motion: animate(clip, target, {
                  type: 'spring',
                  duration: 0.08,
                  bounce: 0,
                  opacity: { duration: 0.06 },
                }),
              });
          }
        };
        const observer = new MutationObserver(sync);
        observer.observe(root, {
          attributes: true,
          subtree: true,
          attributeFilter: ['aria-selected', 'data-size', 'data-radius'],
        });
        const resize = new ResizeObserver(sync);
        for (const label of root.querySelectorAll('.ff-tab-label')) resize.observe(label);
        sync();
        return () => {
          hover.dispose();
          focus();
          observer.disconnect();
          resize.disconnect();
          labels.forEach((label) => label.motion?.stop());
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.andThen(Effect.never)),
});
