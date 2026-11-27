import { Menu } from '@foldkit/ui';
import { Option, Schema } from 'effect';
import { Command, type Update } from 'foldkit';
import { defineMessageUnion } from 'foldkit/message';
import * as Dropdown from './index';
import * as Searchable from './search-state';

export interface Item extends Dropdown.Item {
  readonly children?: readonly Item[];
}
export const Model = Schema.Struct({
  id: Schema.String,
  menus: Schema.Record(Schema.String, Menu.Model),
  openPath: Schema.Array(Schema.Number),
  query: Schema.String,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  Behavior: { path: Schema.Array(Schema.Number), message: Menu.Message },
  OpenedSubmenu: {
    path: Schema.Array(Schema.Number),
    index: Schema.Number,
    keyboard: Schema.Boolean,
  },
  ClosedSubmenu: { path: Schema.Array(Schema.Number) },
  Dismissed: {},
  Search: { message: Searchable.Message },
});
export type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  Selected: { value: Schema.String, path: Schema.Array(Schema.String) },
  Created: { value: Schema.String, path: Schema.Array(Schema.String) },
});
export type OutMessage = typeof OutMessage.Type;
type Result = Update.ReturnWithOutMessage<Model, Message, OutMessage>;
export const pathKey = (path: readonly number[]) => path.join('.');
export const menuId = (id: string, path: readonly number[]) =>
  path.length ? `${id}-sub-${path.join('-')}` : id;
export function itemsAt(items: readonly Item[], path: readonly number[]): readonly Item[] {
  let current = items;
  for (const index of path) current = current[index]?.children ?? [];
  return current;
}
export const init = ({ id }: { readonly id: string }): Model => ({
  id,
  menus: { '': Dropdown.init({ id }) },
  openPath: [],
  query: '',
});

export interface UpdateOptions {
  readonly selectionForPath?: (path: readonly number[]) => Dropdown.Panel.Selection['mode'];
  readonly search?: boolean;
}
export function update(
  model: Model,
  message: Message,
  items: readonly Item[],
  options: UpdateOptions = {},
): Result {
  let menus = { ...model.menus },
    openPath = model.openPath,
    query = model.query;
  const visibleItems = options.search ? Searchable.matches(items, query) : items;
  const levelItems = (path: readonly number[]) =>
    path.length ? itemsAt(items, path) : visibleItems;
  const stableIndex = (path: readonly number[], index: number) =>
    path.length ? index : items.findIndex((item) => item.value === visibleItems[index]?.value);
  const commands: NonNullable<Result['commands']>[number][] = [];
  const apply = (path: readonly number[], message: Menu.Message, firstEnabledIndex = 0) => {
    const key = pathKey(path),
      before = menus[key] ?? Dropdown.init({ id: menuId(model.id, path) });
    const result = Dropdown.update(before, message, {
      firstEnabledIndex: options.search && !path.length ? -1 : firstEnabledIndex,
    });
    if (
      !path.length &&
      options.search &&
      ((!before.isOpen && result.model.isOpen) ||
        (!result.model.isOpen && result.model.animation.transitionState === 'Idle'))
    )
      query = '';
    menus[key] = result.model;
    commands.push(
      ...(result.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) => Message.Behavior({ path, message })),
      ),
    );
    return result;
  };
  const closeBelow = (depth: number) => {
    for (const key of Object.keys(menus)) {
      const path = key ? key.split('.').map(Number) : [];
      if (path.length > depth && menus[key]?.isOpen) apply(path, Menu.Message.BlurredItems());
    }
    openPath = openPath.slice(0, depth);
  };
  const focus = (path: readonly number[]) =>
    commands.push(
      Command.mapMessage(Menu.FocusItems({ id: menuId(model.id, path) }), (message) =>
        Message.Behavior({ path, message }),
      ),
    );
  const open = (path: readonly number[], index: number, keyboard: boolean) => {
    const item = levelItems(path)[index];
    if (!item?.children?.length || item.disabled || !menus[pathKey(path)]?.isOpen) return;
    const child = [...path, stableIndex(path, index)];
    if (pathKey(openPath) !== pathKey(child)) closeBelow(path.length);
    apply(
      path,
      Menu.Message.ActivatedItem({ index, activationTrigger: keyboard ? 'Keyboard' : 'Pointer' }),
    );
    const first = item.children.findIndex((item) => !item.disabled);
    apply(
      child,
      Menu.Message.Opened({
        maybeActiveItemIndex: keyboard && first >= 0 ? Option.some(first) : Option.none(),
      }),
      keyboard ? first : -1,
    );
    openPath = child;
  };
  let outMessage: OutMessage | undefined;
  if (message._tag === 'Search') {
    const event = message.message;
    if (event._tag === 'Behavior')
      return update(model, Message.Behavior({ path: [], message: event.message }), items, options);
    const result = Searchable.update({ menu: menus['']!, query }, event);
    menus[''] = result.model.menu;
    query = result.model.query;
    closeBelow(0);
    commands.push(
      ...(result.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) => Message.Search({ message })),
      ),
    );
    if (result.outMessage?._tag === 'Created') {
      const value = result.outMessage.value;
      outMessage = OutMessage.Created({ value, path: [value] });
      if (options.selectionForPath?.([]) !== 'multiple') apply([], Menu.Message.Closed());
    }
  } else if (message._tag === 'OpenedSubmenu') open(message.path, message.index, message.keyboard);
  else if (message._tag === 'ClosedSubmenu') {
    if (!message.path.length || !message.path.every((index, depth) => openPath[depth] === index))
      return { model };
    closeBelow(message.path.length - 1);
    focus(message.path.slice(0, -1));
  } else if (message._tag === 'Dismissed') {
    apply([], Menu.Message.BlurredItems());
    closeBelow(0);
  } else {
    const { path, message: event } = message;
    const currentItems = levelItems(path);
    if (
      ['SelectedItem', 'ActivatedItem', 'MovedPointerOverItem', 'DeactivatedItem'].includes(
        event._tag,
      ) &&
      !menus[pathKey(path)]?.isOpen
    )
      return { model };
    if (event._tag === 'SelectedItem') {
      const item = currentItems[event.index];
      if (!item || item.disabled || item.value !== event.item) return { model };
      if (item.children?.length) open(path, event.index, true);
      else {
        const values: string[] = [];
        let level = items;
        for (const index of path) {
          const parent = level[index];
          if (!parent) return { model };
          values.push(parent.value);
          level = parent.children ?? [];
        }
        outMessage = OutMessage.Selected({ value: item.value, path: [...values, item.value] });
        if (options.selectionForPath?.(path) !== 'multiple') {
          apply([], Menu.Message.Closed());
          closeBelow(0);
        }
      }
    } else if (event._tag === 'Closed' && path.length) {
      if (!path.every((index, depth) => openPath[depth] === index)) return { model };
      closeBelow(path.length - 1);
      focus(path.slice(0, -1));
    } else {
      apply(
        path,
        event,
        currentItems.findIndex((item) => !item.disabled),
      );
      const activeBranch =
        path.length <= openPath.length && path.every((index, depth) => openPath[depth] === index);
      if (!menus[pathKey(path)]?.isOpen && activeBranch) closeBelow(Math.max(0, path.length - 1));
      else if (event._tag === 'DeactivatedItem' && openPath[path.length] !== undefined)
        closeBelow(path.length);
      else if (
        (event._tag === 'ActivatedItem' || event._tag === 'MovedPointerOverItem') &&
        openPath[path.length] !== undefined &&
        openPath[path.length] !== stableIndex(path, event.index)
      )
        closeBelow(path.length);
    }
  }
  return { model: { ...model, menus, openPath, query }, commands, outMessage };
}
