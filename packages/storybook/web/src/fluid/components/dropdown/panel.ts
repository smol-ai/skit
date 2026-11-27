import { Button, Checkbox } from '@foldkit/ui';
import { Effect, Schema } from 'effect';
import { Mount } from 'foldkit';
import type { Html, HtmlBuilder } from 'foldkit/html';
import { Mounted, rowContent } from '../popup';
import type { Item } from './index';
import './styles.css';

const Navigation = Mount.define('Dropdown.PanelNavigation', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const key = (event: KeyboardEvent) => {
          const rows = [...element.querySelectorAll<HTMLElement>('.ff-popup-row')];
          const index = rows.indexOf(event.target as HTMLElement);
          if (index < 0) return;
          let next: number;
          if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
            next = (index + 1) % rows.length;
          else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
            next = (index - 1 + rows.length) % rows.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = rows.length - 1;
          else return;
          event.preventDefault();
          rows[next]?.focus();
        };
        element.addEventListener('keydown', key);
        return () => element.removeEventListener('keydown', key);
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.andThen(Effect.never)),
});

export type Selection =
  | { readonly mode: 'none' }
  | { readonly mode: 'single'; readonly value?: string }
  | { readonly mode: 'multiple'; readonly values: readonly string[] };
export interface Props<Message> {
  readonly id: string;
  readonly label: string;
  readonly items: readonly Item[];
  readonly selection: Selection;
  readonly onSelect: (value: string) => Message;
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly size?: 'default' | 'compact';
  readonly className?: string;
}

/** A static group, with no trigger, portal, or popup-menu claim. */
export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  const children: Html[] = [];
  const selection = props.selection;
  const tabStop =
    selection.mode === 'single'
      ? props.items.findIndex((item) => item.value === selection.value)
      : selection.mode === 'multiple'
        ? props.items.findIndex((item) => selection.values.includes(item.value))
        : 0;
  const rowAttributes = (item: Item, index: number) => [
    h.Tabindex(!item.disabled && index === Math.max(0, tabStop) ? 0 : -1),
    h.AriaLabel(item.label),
  ];
  let group: string | undefined;
  props.items.forEach((item, index) => {
    if (group !== item.group) {
      if (index > 0) children.push(h.div([h.Class('ff-popup-separator'), h.Role('separator')], []));
      if (item.group) children.push(h.span([h.Class('ff-popup-heading')], [item.group]));
      group = item.group;
    }
    if (props.selection.mode === 'none') {
      children.push(
        Button.view(
          {
            isDisabled: item.disabled,
            onClick: props.onSelect(item.value),
            toView: ({ button }) =>
              h.button(
                [
                  ...button,
                  h.Role('menuitem'),
                  h.Class('ff-popup-row'),
                  ...rowAttributes(item, index),
                  ...(item.disabled ? [h.AriaDisabled(true)] : []),
                ],
                [rowContent(item, h)],
              ),
          },
          h,
        ),
      );
    } else {
      const checked =
        props.selection.mode === 'single'
          ? props.selection.value === item.value
          : props.selection.values.includes(item.value);
      children.push(
        Checkbox.view(
          {
            id: `${props.id}-item-${index}`,
            isChecked: checked,
            isDisabled: item.disabled,
            onToggle: () => props.onSelect(item.value),
            toView: ({ checkbox }) =>
              h.button(
                [
                  ...checkbox,
                  h.Class('ff-popup-row'),
                  ...rowAttributes(item, index),
                  h.Role(
                    props.selection.mode === 'multiple' ? 'menuitemcheckbox' : 'menuitemradio',
                  ),
                ],
                [
                  h.span(
                    [
                      h.Id(Checkbox.labelId(`${props.id}-item-${index}`)),
                      h.Class('ff-popup-row-content'),
                    ],
                    [rowContent({ ...item, check: true }, h)],
                  ),
                ],
              ),
          },
          h,
        ),
      );
    }
  });
  return h.div(
    [
      h.Class(`ff-popup ff-dropdown-panel ${props.className ?? ''}`),
      h.Role('group'),
      h.AriaLabel(props.label),
      h.DataAttribute('size', props.size ?? 'default'),
      h.DataAttribute('radius',props.radius === 'sharp' ? 'sharp' : 'rounded'),
      h.DataAttribute('selection', props.selection.mode),
      h.OnMount(Navigation()),
    ],
    [
      h.div(
        [h.Class('ff-popup-viewport ff-dropdown-panel-viewport'), h.OnMount(Mounted())],
        children,
      ),
    ],
  );
}
