import type { Html } from 'foldkit/html';

export interface Item {
  /** Unique id: the row's key, its option id suffix and the Selected value. */
  readonly value: string;
  readonly label: string;
  /** What the footer names Enter while the row is highlighted. Defaults to the label. */
  readonly action?: string;
  /** Secondary text after the label, in the muted colour. */
  readonly description?: string;
  readonly icon?: Html;
  /** Display only, e.g. "mod+p" or "⌘⇧P". Bind the combo yourself. */
  readonly shortcut?: string;
  /** Extra terms the filter matches besides label and description. */
  readonly keywords?: readonly string[];
  /** Heading the row is listed under; groups keep first-appearance order. */
  readonly group?: string;
  readonly disabled?: boolean;
}
export type Filter = (item: Item, query: string) => boolean;
/** Every word of the query appears in the label, description or keywords.
 * Order is kept, so rows never re-sort under the cursor. */
export const defaultFilter: Filter = (item, query) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [item.label, item.description ?? '', ...(item.keywords ?? [])]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
};
export interface Section {
  readonly id: string;
  readonly heading: string | null;
  readonly items: readonly Item[];
  /** Flat index of the section's first row. */
  readonly start: number;
}
/** Groups the visible rows, suggestions first while the query is empty. A
 * suggested row leaves its own group so nothing is listed twice. */
export function sections(
  visible: readonly Item[],
  suggestions: readonly string[] | undefined,
  suggestionsLabel: string,
  query: string,
): readonly Section[] {
  const out: { id: string; heading: string | null; items: Item[]; start: number }[] = [];
  const byHeading = new Map<string | null, (typeof out)[number]>();
  const suggested = new Set(query === '' ? (suggestions ?? []) : []);
  const push = (heading: string | null, id: string, item: Item) => {
    let section = byHeading.get(heading);
    if (!section) {
      section = { id, heading, items: [], start: 0 };
      byHeading.set(heading, section);
      out.push(section);
    }
    section.items.push(item);
  };
  if (suggested.size > 0) {
    const pool = new Map(visible.map((item) => [item.value, item]));
    for (const value of suggestions ?? []) {
      const item = pool.get(value);
      if (item) push(suggestionsLabel, 'suggestions', item);
    }
  }
  for (const item of visible)
    if (!suggested.has(item.value))
      push(item.group ?? null, item.group ? `group:${item.group}` : 'ungrouped', item);
  let start = 0;
  for (const section of out) {
    section.start = start;
    start += section.items.length;
  }
  return out;
}
export interface ListOptions {
  readonly items: readonly Item[];
  readonly filter?: Filter;
  readonly suggestions?: readonly string[];
  /** Defaults to "Suggestions". */
  readonly suggestionsLabel?: string;
}
export interface Resolved {
  readonly sections: readonly Section[];
  /** The visible rows, flat, in list order: the keyboard's index space. */
  readonly rows: readonly Item[];
  /** What the rows are: a change resets the highlight to the first row. */
  readonly key: string;
}
export function resolve(query: string, options: ListOptions): Resolved {
  const filter = options.filter ?? defaultFilter;
  const visible =
    query === '' ? options.items : options.items.filter((item) => filter(item, query));
  const grouped = sections(
    visible,
    options.suggestions,
    options.suggestionsLabel ?? 'Suggestions',
    query,
  );
  const rows = grouped.flatMap((section) => section.items);
  // Joined on NUL so values containing spaces cannot collide.
  return { sections: grouped, rows, key: rows.map((row) => row.value).join('\u0000') };
}
export const firstEnabled = (rows: readonly Item[]): number | null => {
  const index = rows.findIndex((row) => !row.disabled);
  return index === -1 ? null : index;
};
export type Move = 'next' | 'previous' | 'first' | 'last';
/** Steps wrap at both ends: the list is the whole keyboard space. */
export function step(rows: readonly Item[], current: number | null, to: Move): number | null {
  const enabled = rows.flatMap((row, i) => (row.disabled ? [] : [i]));
  if (enabled.length === 0) return null;
  if (to === 'first') return enabled[0]!;
  if (to === 'last') return enabled.at(-1)!;
  const position = current === null ? -1 : enabled.indexOf(current);
  if (position === -1) return to === 'next' ? enabled[0]! : enabled.at(-1)!;
  const delta = to === 'next' ? 1 : -1;
  return enabled[(position + delta + enabled.length) % enabled.length]!;
}
