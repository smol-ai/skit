import { shapeRadius } from '../shape';
import { Effect } from 'effect';
import { Mount } from 'foldkit';
import { animate, type AnimationPlaybackControls } from 'motion';
import { Message } from './state';
import { mountHover } from '../../fluid-hover/engine';

export const AccordionRuntime = Mount.define('Accordion.Runtime', {
  messages: [Message.Noop],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const reduced = matchMedia('(prefers-reduced-motion: reduce)');
        const panels = [...element.querySelectorAll<HTMLElement>('[data-accordion-panel]')];
        const state = new Map<
          HTMLElement,
          {
            open: boolean;
            height?: AnimationPlaybackControls;
            opacity?: AnimationPlaybackControls;
            run: number;
          }
        >();
        const hover = mountHover(element, {
          itemSelector: '[data-accordion-hover]',
          nearest: true,
          followLayout: true,
          axis: 'y',
          radius: () => `${shapeRadius(element.dataset.radius, 8, 20, 1)}px`,
        });
        const resize = new ResizeObserver(() => {
          for (const panel of panels) {
            const s = state.get(panel);
            if (s?.open && !s.height && panel.firstElementChild instanceof HTMLElement)
              panel.style.setProperty(
                '--accordion-height',
                `${panel.firstElementChild.offsetHeight}px`,
              );
          }
          hover.measure();
        });
        const sync = () => {
          for (const panel of panels) {
            const open = panel.dataset.state === 'open',
              previous = state.get(panel);
            const inner = panel.firstElementChild;
            if (!(inner instanceof HTMLElement) || previous?.open === open) continue;
            const run = (previous?.run ?? 0) + 1;
            previous?.height?.stop();
            previous?.opacity?.stop();
            const s = {
              open,
              run,
              height: undefined as AnimationPlaybackControls | undefined,
              opacity: undefined as AnimationPlaybackControls | undefined,
            };
            state.set(panel, s);
            const from = previous ? panel.offsetHeight : open ? inner.offsetHeight : 0;
            panel.hidden = false;
            const target = open ? inner.offsetHeight : 0;
            if (!previous || reduced.matches) {
              panel.style.setProperty('--accordion-height', `${target}px`);
              panel.style.setProperty('--accordion-opacity', String(open ? 1 : 0));
              panel.hidden = !open;
            } else {
              s.height = animate(from, target, {
                type: 'spring',
                duration: open ? 0.08 : 0.06,
                bounce: 0,
                onUpdate: (height) => {
                  panel.style.setProperty('--accordion-height', `${height}px`);
                  hover.measure();
                },
                onComplete: () => {
                  if (state.get(panel)?.run === run) {
                    panel.hidden = !open;
                    s.height = undefined;
                    hover.measure();
                  }
                },
              });
              s.opacity = animate(
                Number(panel.style.getPropertyValue('--accordion-opacity')) || 0,
                open ? 1 : 0,
                {
                  duration: open ? 0.06 : 0.04,
                  onUpdate: (opacity) =>
                    panel.style.setProperty('--accordion-opacity', String(opacity)),
                },
              );
            }
            resize.observe(inner);
          }
          hover.measure();
        };
        const change = new MutationObserver(sync);
        change.observe(element, {
          subtree: true,
          attributes: true,
          attributeFilter: ['data-state', 'data-accordion-highlight'],
        });
        const key = (event: KeyboardEvent) => {
          const triggers = [
            ...element.querySelectorAll<HTMLButtonElement>(
              '[data-accordion-trigger]:not(:disabled)',
            ),
          ];
          const current = triggers.indexOf(event.target as HTMLButtonElement);
          if (current < 0) return;
          let next: number;
          if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = triggers.length - 1;
          else if (event.key === 'ArrowDown') next = (current + 1) % triggers.length;
          else if (event.key === 'ArrowUp')
            next = (current - 1 + triggers.length) % triggers.length;
          else return;
          event.preventDefault();
          triggers[next]?.focus();
        };
        element.addEventListener('keydown', key);
        sync();
        return () => {
          change.disconnect();
          resize.disconnect();
          hover.dispose();
          element.removeEventListener('keydown', key);
          for (const s of state.values()) {
            s.height?.stop();
            s.opacity?.stop();
          }
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.as(Message.Noop())),
});
