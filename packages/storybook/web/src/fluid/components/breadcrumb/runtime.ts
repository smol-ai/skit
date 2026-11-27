import { Effect, Queue, Stream } from 'effect';
import { Mount } from 'foldkit';
import { mountHover } from '../../fluid-hover/engine';
import { shapeRadius } from '../shape';
import { Message } from './state';
import '../../fluid-hover/styles.css';

export const Mounted = Mount.defineStream('Breadcrumb.Layout', {
  messages: [Message.Measured, Message.LabelMeasured],
  execute: ({ element }) =>
    Stream.callback<typeof Message.Measured.Type | typeof Message.LabelMeasured.Type>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (!(element instanceof HTMLElement)) return () => {};
          return mountBreadcrumb(element, (message) => Queue.offerUnsafe(queue, message));
        }),
        (dispose) => Effect.sync(dispose),
      ),
    ),
});

export function mountBreadcrumb(
  root: HTMLElement,
  send: (message: typeof Message.Measured.Type | typeof Message.LabelMeasured.Type) => void,
): () => void {
  const widths: number[] = [];
  const cuts = new Map<string, boolean>();
  let signature = '',
    frame = 0,
    disposed = false;
  const hover = mountHover(root, {
    itemSelector: '[data-breadcrumb-target]',
    ownsItem: (item) => item.closest('.ff-breadcrumb') === root,
    axis: 'xy',
    nearest: false,
    keyboardNavigation: false,
    followLayout: true,
    enabled: () => document.documentElement.dataset.hover !== 'standard',
    radius: () => `${shapeRadius(root.dataset.radius)}px`,
  });
  const measure = () => {
    frame = 0;
    const count = Number(root.dataset.count);
    widths.length = count;
    let ellipsis = 44;
    for (const item of root.querySelectorAll<HTMLElement>('.ff-breadcrumb-list > li')) {
      const index = item.dataset.index;
      if (index === 'more') {
        ellipsis = item.getBoundingClientRect().width;
        continue;
      }
      if (index === undefined) continue;
      const label = item.querySelector<HTMLElement>('.ff-breadcrumb-label');
      const page = item.querySelector('[aria-current="page"]');
      widths[Number(index)] =
        item.getBoundingClientRect().width +
        (page && label ? Math.max(0, label.scrollWidth - label.clientWidth) : 0);
    }
    for (const target of root.querySelectorAll<HTMLElement>('[data-breadcrumb-key]')) {
      const key = target.dataset.breadcrumbKey!;
      const label = target.querySelector<HTMLElement>('.ff-breadcrumb-label');
      const cut = !!label && label.scrollWidth > label.clientWidth + 0.5;
      if (cuts.get(key) !== cut) {
        cuts.set(key, cut);
        send(Message.LabelMeasured({ key, cut }));
      }
    }
    const next = JSON.stringify([widths, root.clientWidth, ellipsis]);
    if (next !== signature && widths.filter(Number.isFinite).length === count) {
      signature = next;
      send(Message.Measured({ widths: [...widths], available: root.clientWidth, ellipsis }));
    }
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(measure);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  const observer = new MutationObserver(schedule);
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-size', 'data-count', 'data-radius'],
  });
  document.fonts?.ready.then(schedule);
  // A remounted trail may retain a collapsed Model, while this Mount's width
  // cache starts empty. Reveal it once so every step can be measured again.
  send(Message.Measured({ widths: [], available: root.clientWidth, ellipsis: 44 }));
  schedule();
  return () => {
    disposed = true;
    resize.disconnect();
    observer.disconnect();
    cancelAnimationFrame(frame);
    hover.dispose();
  };
}
