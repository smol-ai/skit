import { Option, Schema } from 'effect';
import { Command, Submodel, type Update } from 'foldkit';
import { defineMessageUnion } from 'foldkit/message';
import type { ChildAttribute, Html, HtmlBuilder } from 'foldkit/html';
import * as Tabs from '../tabs';
import * as ScrollArea from '../scroll-area';
import { icon as projectIcon } from '../icons';
import { formatShortcut } from './shortcuts';
import {
  firstEnabled,
  resolve,
  step,
  type Item,
  type ListOptions,
  type Move,
  type Resolved,
} from './state';
import { Mounted } from './runtime';
import { Message } from './messages';
import '../../fluid-hover/styles.css';
import './styles.css';
export * from './shortcuts';
export { defaultFilter, resolve, sections, type Filter, type Item, type Section } from './state';

/** A search field over a list of actions: type to filter, arrows to move the
 * highlight, Enter to run. The field keeps DOM focus and points at the
 * highlighted row through aria-activedescendant, so the list needs no
 * primitive of its own, as upstream. The consumer owns the items (and any
 * tab value); the model owns the query and the highlight. */
export const Model = Schema.Struct({
  id: Schema.String,
  query: Schema.String,
  active: Schema.NullOr(Schema.Number),
  /** The row set `active` indexes; a different set resets to the first row. */
  rows: Schema.String,
  /** Keyboard moves, counted so a move to the same row still scrolls. */
  moves: Schema.Number,
  source: Schema.Literals(['reset', 'keyboard', 'pointer']),
  tabs: Tabs.Model,
});
export interface Model extends Schema.Schema.Type<typeof Model> {}
export const init = (config: { readonly id: string; readonly query?: string }): Model => ({
  id: config.id,
  query: config.query ?? '',
  active: null,
  rows: '\u0001',
  moves: 0,
  source: 'reset',
  tabs: Tabs.init({ id: `${config.id}-tabs` }),
});
export { Message } from './messages';
export const OutMessage = defineMessageUnion({
  /** A row was picked. Inside a dialog the consumer closes it (unless it keeps
   * the menu open); the item's own action is the consumer's to run. */
  Selected: { value: Schema.String },
  TabChanged: { value: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;

export interface Tab {
  readonly value: string;
  readonly label: string;
  readonly icon?: Html;
}
export interface UpdateOptions extends ListOptions {
  /** The tabs under the field, if any: ← and → in the field switch them. */
  readonly tabs?: { readonly items: readonly Pick<Tab, 'value'>[]; readonly value: string };
}

/** The highlight the view draws and the keyboard starts from: the stored
 * index while the row set is unchanged, otherwise the first enabled row. */
export function current(model: Model, resolved: Resolved): number | null {
  if (model.rows !== resolved.key) return firstEnabled(resolved.rows);
  return model.active !== null && model.active < resolved.rows.length ? model.active : null;
}

export function update(
  model: Model,
  message: Message,
  options: UpdateOptions,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> {
  const settle = (query: string) => {
    const resolved = resolve(query, options);
    return { resolved, active: current({ ...model, query }, resolved) };
  };
  const { resolved, active } = settle(model.query);
  const base = { ...model, rows: resolved.key, active };
  switch (message._tag) {
    case 'QueryChanged': {
      const next = resolve(message.query, options);
      return {
        model: {
          ...model,
          query: message.query,
          rows: next.key,
          active: current({ ...model, query: message.query }, next),
          source: next.key === model.rows ? model.source : 'reset',
        },
      };
    }
    case 'Moved':
      return {
        model: {
          ...base,
          active: step(resolved.rows, active, message.to as Move),
          moves: model.moves + 1,
          source: 'keyboard',
        },
      };
    case 'Hovered': {
      const row = resolved.rows[message.index];
      if (!row || row.disabled || (message.index === active && model.source === 'pointer'))
        return { model: base };
      return { model: { ...base, active: message.index, source: 'pointer' } };
    }
    case 'Picked': {
      const index = message.index ?? active;
      const row = index === null ? undefined : resolved.rows[index];
      if (!row || row.disabled) return { model: base };
      return { model: base, outMessage: OutMessage.Selected({ value: row.value }) };
    }
    case 'Cleared': {
      const next = resolve('', options);
      return {
        model: {
          ...model,
          query: '',
          rows: next.key,
          active: current({ ...model, query: '' }, next),
          source: 'reset',
        },
      };
    }
    case 'TabStepped': {
      const tabs = options.tabs;
      if (!tabs || tabs.items.length === 0) return { model: base };
      const count = tabs.items.length,
        index = Math.max(
          0,
          tabs.items.findIndex((tab) => tab.value === tabs.value),
        );
      const value = tabs.items[(index + message.step + count) % count]!.value;
      return { model: base, outMessage: OutMessage.TabChanged({ value }) };
    }
    case 'Tabs': {
      const result = Tabs.update(model.tabs, message.message);
      return {
        model: { ...base, tabs: result.model },
        commands: (result.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) => Message.Tabs({ message })),
        ),
        ...(result.outMessage
          ? { outMessage: OutMessage.TabChanged({ value: result.outMessage.value }) }
          : {}),
      };
    }
  }
}

export interface Hint {
  readonly label: string;
  /** A combo, or a list of separate caps. */
  readonly keys: string | readonly string[];
}
export interface Props extends ListOptions {
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  /** Icon set for the default search glyph. */
  readonly icons?: string;
  readonly placeholder?: string;
  /** Leading glyph; `null` hides it. Defaults to the search icon. */
  readonly icon?: Html | null;
  /** Draw ⌘ and ⌥ (true) or Ctrl and Alt. Defaults to true. */
  readonly mac?: boolean;
  /** Inside a dialog: Escape belongs to the shell and the footer says so. */
  readonly inDialog?: boolean;
  /** Extra attributes for the field, e.g. a dialog's initial-focus slot. */
  readonly inputAttributes?: readonly ChildAttribute[];
  readonly tabs?: { readonly items: readonly Tab[]; readonly value: string };
  /** A compact control bar under the field (borderless Selects, ghost
   * Buttons). A function, so its controls may carry Mounts and Messages. */
  readonly filters?: () => readonly Html[];
  /** The trailing edge of the tab row, e.g. filters beside the tabs. */
  readonly tabsTrailing?: () => readonly Html[];
  /** Shown in place of the rows when nothing matches. */
  readonly empty?: Html | string;
  /** Footer hints. `true` uses the defaults; omit for no footer. */
  readonly footer?: true | { readonly hints: readonly Hint[] };
  /** Replaces a row's label area; its icon, caps, highlight and events stay
   * the menu's, as upstream's CommandMenuItem children do. */
  readonly renderItem?: (item: Item, index: number, active: boolean) => Html;
  readonly className?: string;
}

const caps = (keys: string | readonly string[], mac: boolean) =>
  (typeof keys === 'string' ? [keys] : keys).flatMap((key) => formatShortcut(key, mac));
export function shortcut<Message>(
  keys: string | readonly string[],
  props: {
    readonly mac?: boolean;
    readonly size?: 'default' | 'compact';
    readonly inline?: boolean;
  },
  h: HtmlBuilder<Message>,
): Html {
  return h.kbd(
    [
      h.Class('ff-command-shortcut'),
      h.DataAttribute('slot', 'command-menu-shortcut'),
      h.DataAttribute('size', props.size ?? 'default'),
      ...(props.inline ? [h.DataAttribute('inline', '')] : []),
    ],
    caps(keys, props.mac ?? true).map((cap) => h.span([h.Class('ff-command-cap')], [cap])),
  );
}

export const view = Submodel.defineView<Model, Message, Props>((model, props, h) => {
  const size = props.size ?? 'default',
    mac = props.mac ?? true;
  const resolved = resolve(model.query, props),
    active = current(model, resolved);
  const listId = `${model.id}-list`;
  const rowId = (index: number) => `${listId}-${index}`;
  const searchIcon =
    props.icon === undefined
      ? projectIcon('search', props.icons, h, {
          attributes: [h.DataAttribute('library', props.icons ?? 'Untitled UI')],
        })
      : props.icon;
  const key = (
    pressed: string,
    modifiers: {
      readonly shiftKey: boolean;
      readonly altKey: boolean;
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
    },
  ): Option.Option<Message> => {
    const plain =
      !modifiers.shiftKey && !modifiers.altKey && !modifiers.metaKey && !modifiers.ctrlKey;
    switch (pressed) {
      case 'ArrowLeft':
      case 'ArrowRight':
        // With tabs under the field ← and → switch tabs; modified presses keep
        // their editing meaning (Shift+Arrow extends the selection).
        return props.tabs && props.tabs.items.length > 0 && plain
          ? Option.some(Message.TabStepped({ step: pressed === 'ArrowRight' ? 1 : -1 }))
          : Option.none();
      case 'ArrowDown':
        return Option.some(Message.Moved({ to: 'next' }));
      case 'ArrowUp':
        return Option.some(Message.Moved({ to: 'previous' }));
      case 'Home':
        return model.query === '' ? Option.some(Message.Moved({ to: 'first' })) : Option.none();
      case 'End':
        return model.query === '' ? Option.some(Message.Moved({ to: 'last' })) : Option.none();
      case 'Enter':
        return Option.some(Message.Picked({ index: null }));
      case 'Escape':
        // In a dialog the shell closes on Escape; inline it clears the query.
        return props.inDialog || model.query === ''
          ? Option.none()
          : Option.some(Message.Cleared());
      default:
        return Option.none();
    }
  };
  const input = h.div(
    [h.Class('ff-command-input'), h.DataAttribute('slot', 'command-menu-input')],
    [
      searchIcon
        ? h.span([h.Class('ff-command-input-icon'), h.AriaHidden(true)], [searchIcon])
        : null,
      h.input([
        h.Id(`${model.id}-input`),
        h.Class('ff-command-field'),
        h.Type('text'),
        h.Role('combobox'),
        h.Attribute('aria-expanded', 'true'),
        h.AriaControls(listId),
        h.Attribute('aria-autocomplete', 'list'),
        ...(active === null ? [] : [h.Attribute('aria-activedescendant', rowId(active))]),
        h.Attribute('autocomplete', 'off'),
        h.Attribute('autocorrect', 'off'),
        h.Attribute('spellcheck', 'false'),
        h.Placeholder(props.placeholder ?? 'Type a command or search…'),
        h.Value(model.query),
        h.OnInput((query) => Message.QueryChanged({ query })),
        h.OnKeyDownPreventDefault(key),
        ...(props.inputAttributes ?? []),
      ]),
    ],
  );
  const tabs = props.tabs
    ? h.div(
        [h.Class('ff-command-tabs'), h.DataAttribute('slot', 'command-menu-tabs')],
        [
          h.div(
            [h.Class('ff-command-tabs-list'), h.DataAttribute('command-keep-focus', '')],
            [
              h.submodel({
                slotId: 'tabs',
                model: model.tabs,
                view: Tabs.view,
                toParentMessage: (message) => Message.Tabs({ message }),
                viewInputs: {
                  label: 'Filter results',
                  value: props.tabs.value,
                  size: 'compact',
                  ...(props.radius ? { radius: props.radius } : {}),
                  items: props.tabs.items.map((tab) => ({
                    value: tab.value,
                    label: tab.label,
                    ...(tab.icon ? { icon: tab.icon } : {}),
                  })),
                },
              }),
            ],
          ),
          props.tabsTrailing
            ? h.div([h.Class('ff-command-tabs-trailing')], props.tabsTrailing())
            : null,
        ],
      )
    : null;
  const filters = props.filters
    ? h.div(
        [h.Class('ff-command-filters'), h.DataAttribute('slot', 'command-menu-filters')],
        props.filters(),
      )
    : null;
  const row = (item: Item, index: number) => {
    const isActive = index === active;
    return h.div(
      [
        h.Key(item.value),
        h.Id(rowId(index)),
        h.Role('option'),
        h.AriaSelected(isActive),
        ...(item.disabled ? [h.AriaDisabled(true)] : []),
        h.DataAttribute('fluid-hover-index', String(index)),
        h.DataAttribute('value', item.value),
        h.DataAttribute('slot', 'command-menu-item'),
        ...(isActive ? [h.DataAttribute('active', '')] : []),
        h.Class('ff-command-item'),
        h.OnClick(Message.Picked({ index })),
      ],
      [
        item.icon
          ? h.span([h.Class('ff-command-item-icon'), h.AriaHidden(true)], [item.icon])
          : null,
        props.renderItem
          ? props.renderItem(item, index, isActive)
          : h.span(
              [h.Class('ff-command-item-text')],
              [
                h.span([h.Class('ff-command-item-label')], [item.label]),
                item.description
                  ? h.span([h.Class('ff-command-item-description')], [item.description])
                  : null,
              ],
            ),
        item.shortcut ? shortcut(item.shortcut, { mac, size }, h) : null,
      ],
    );
  };
  const empty = resolved.rows.length === 0;
  const list = ScrollArea.view(
    {
      className: 'ff-command-scroll scroll-divider',
      viewportClassName: 'ff-command-viewport scroll-fade',
      viewportFocusable: false,
      children: [
        h.div(
          [
            h.Id(listId),
            h.Role('listbox'),
            h.Tabindex(-1),
            h.Class('ff-command-list'),
            h.DataAttribute('slot', 'command-menu-list'),
            ...(empty ? [h.DataAttribute('empty', '')] : []),
          ],
          [
            empty && props.empty !== undefined
              ? h.div(
                  [
                    h.Role('status'),
                    h.Attribute('aria-live', 'polite'),
                    h.Class('ff-command-empty'),
                    h.DataAttribute('slot', 'command-menu-empty'),
                  ],
                  [props.empty],
                )
              : null,
            ...resolved.sections.map((section, sectionIndex) => {
              // Ids from the section's position: a heading with a space would
              // split aria-labelledby into ids that exist nowhere.
              const headingId = section.heading ? `${listId}-group-${sectionIndex}` : undefined;
              return h.div(
                [
                  h.Key(section.id),
                  h.Role('group'),
                  ...(headingId ? [h.AriaLabelledBy(headingId)] : []),
                  h.Class('ff-command-group'),
                ],
                [
                  section.heading
                    ? h.div(
                        [h.Id(headingId!), h.Role('presentation'), h.Class('ff-command-heading')],
                        [section.heading],
                      )
                    : null,
                  ...section.items.map((item, i) => row(item, section.start + i)),
                ],
              );
            }),
          ],
        ),
      ],
    },
    h,
  );
  const activeRow = active === null ? undefined : resolved.rows[active];
  const footer = props.footer
    ? h.div(
        [h.Class('ff-command-footer'), h.DataAttribute('slot', 'command-menu-footer')],
        [
          ...(props.footer === true
            ? [
                { label: 'Select', keys: ['up', 'down'] },
                ...(props.tabs ? [{ label: 'Tabs', keys: ['left', 'right'] }] : []),
                ...(props.inDialog ? [{ label: 'Close', keys: 'esc' }] : []),
              ]
            : props.footer.hints
          ).map((hint) =>
            h.span(
              [h.Key(hint.label), h.Class('ff-command-hint')],
              [h.span([], [hint.label]), shortcut(hint.keys, { mac, size, inline: true }, h)],
            ),
          ),
          props.footer === true && activeRow
            ? h.span(
                [
                  h.Class('ff-command-footer-action'),
                  h.DataAttribute('slot', 'command-menu-footer-action'),
                ],
                [
                  h.span(
                    [h.Class('ff-command-footer-action-label')],
                    [activeRow.action ?? activeRow.label],
                  ),
                  shortcut('enter', { mac, size, inline: true }, h),
                ],
              )
            : null,
        ],
      )
    : null;
  return h.div(
    [
      h.Class(`ff-command-menu ${props.className ?? ''}`),
      h.DataAttribute('slot', 'command-menu'),
      h.DataAttribute('size', size),
      h.DataAttribute('radius', props.radius ?? 'rounded'),
      h.DataAttribute('active-source', model.source),
      h.DataAttribute('moves', String(model.moves)),
      h.DataAttribute('rows', String(resolved.rows.length)),
      // The private row key contains NUL separators. Keep the DOM token
      // lossless but representable in serialized HTML as well as live DOM.
      h.DataAttribute('rows-key', JSON.stringify(resolved.key)),
      h.OnMount(Mounted()),
    ],
    [
      h.div(
        [h.Class('ff-command-frame')],
        [h.div([h.Class('ff-command-column')], [input, tabs, filters, list, footer])],
      ),
    ],
  );
});
