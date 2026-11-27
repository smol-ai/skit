/** Tab enters at selected destinations, or the first available row. Each root
 * menu owns Arrow/Home/End focus movement without changing selection. */
export function mountMenuKeyboard(
  root: HTMLElement,
  rows: () => readonly HTMLElement[],
): () => void {
  const available = () =>
    rows().filter(
      (row) =>
        !row.matches(':disabled,[aria-disabled=true],[data-disabled]') &&
        !row.closest('[data-sidebar=menu-sub][data-state=closed]'),
    );
  const sync = () => {
    const items = available();
    const active = items.filter((row) => row.getAttribute('aria-current') === 'page');
    const stops = active.length ? active : items.slice(0, 1);
    for (const row of rows()) row.tabIndex = stops.includes(row) ? 0 : -1;
  };
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const items = available();
    const index = items.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? (index + 1) % items.length
            : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
              ? (index - 1 + items.length) % items.length
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  };
  const changes = new MutationObserver(sync);
  changes.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-current', 'aria-disabled', 'disabled', 'data-disabled', 'data-state'],
  });
  sync();
  root.addEventListener('keydown', key);
  return () => {
    changes.disconnect();
    root.removeEventListener('keydown', key);
  };
}
