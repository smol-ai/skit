import type { Attribute, Html, HtmlBuilder } from 'foldkit/html';
import { cn } from '../../lib/utils';

/** The count treatment shared by sidebar rows, section headings and tabs. */
export interface Props<Message> {
  readonly value: number;
  readonly size?: 'default' | 'compact';
  readonly active?: boolean;
  readonly className?: string;
  readonly attributes?: readonly Attribute<Message>[];
}

export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  return h.span(
    [
      ...(props.attributes ?? []),
      h.DataAttribute('slot', 'count'),
      h.Class(cn(
        'pointer-events-none inline-flex h-5 min-w-5 shrink-0 items-center justify-center px-1 tabular-nums',
        props.size === 'compact'
          ? 'text-[length:var(--fs-micro-compact,10px)] leading-[var(--lh-micro-compact,12px)]'
          : 'text-[length:var(--fs-micro,11px)] leading-[var(--lh-micro,14px)]',
        'transition-[color,font-variation-settings] duration-80',
        props.active ? 'text-foreground' : 'text-muted-foreground',
        props.className,
      )),
      h.Style({ fontVariationSettings: props.active ? "'wght' 550, 'opsz' 18" : "'wght' 400, 'opsz' 14" }),
    ],
    [String(props.value)],
  );
}
