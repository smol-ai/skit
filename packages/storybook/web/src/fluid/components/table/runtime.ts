import { Effect, Schema } from 'effect';
import { Mount } from 'foldkit';
import { mountHover } from '../../fluid-hover/engine';
export const Mounted = Mount.define('Table.Hover', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => (element instanceof HTMLElement ? mountTable(element) : () => {})),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.andThen(Effect.never)),
});
/** Only visual projection lives here. Rows remain native, non-focusable table
 * rows; interactive children retain their ordinary keyboard behavior.
 * `data-hover="off"` on the root (the view's `hover: false`) suspends it. */
export function mountTable(root: HTMLElement): () => void {
  const owns = (row: HTMLElement) => row.closest('.ff-table') === root;
  const rows = () => [...root.querySelectorAll<HTMLElement>('.ff-table-row')].filter(owns);
  let active: HTMLElement | undefined;
  const project = () => {
    if (active && !root.contains(active)) active = undefined;
    const value = active?.getAttribute('data-fluid-hover-index');
    const index = value === null || value === undefined ? null : Number(value);
    for (const row of rows()) {
      const rowIndex = row.getAttribute('data-fluid-hover-index');
      row.classList.toggle('is-active', row === active);
      const hide =
        index !== null &&
        (rowIndex === null
          ? index === 0
          : Number(rowIndex) === index || Number(rowIndex) === index - 1);
      row.toggleAttribute('data-table-hide-border', hide);
    }
  };
  const hover = mountHover(root, {
    itemSelector: '.ff-table-row[data-fluid-hover-index]',
    ownsItem: owns,
    nearest: false,
    axis: 'y',
    focusHighlight: false,
    enabled: () => root.dataset.hover !== 'off',
    keyboardNavigation: false,
    radius: () => '0px',
    onPick: (index) => {
      active = index === null ? undefined : hover.items[index];
      project();
    },
  });
  // A consumer class change makes Foldkit rewrite a row's class attribute,
  // dropping `is-active`; re-projecting restores it. Toggling a class that is
  // already in the requested state records no mutation, so this settles.
  const observer = new MutationObserver((records) => {
    if (
      root.dataset.hover === 'off' &&
      records.some((record) => record.target === root && record.attributeName === 'data-hover')
    )
      hover.leave();
    project();
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-fluid-hover-index', 'class', 'data-hover'],
  });
  return () => {
    observer.disconnect();
    hover.dispose();
    active = undefined;
    project();
  };
}
