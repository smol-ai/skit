import { Schema } from 'effect';
import { defineMessageUnion } from 'foldkit/message';

export interface Item {
  readonly value: string;
  readonly label: string;
  readonly content?: string;
  readonly disabled?: boolean;
}
export interface Options {
  readonly items: readonly Item[];
  readonly type?: 'single' | 'multiple';
  readonly collapsible?: boolean;
  readonly defaultValue?: string | readonly string[];
}
export const Model = Schema.Struct({ expanded: Schema.Array(Schema.String) });
export interface Model extends Schema.Schema.Type<typeof Model> {}
export const Message = defineMessageUnion({ ItemPressed: { value: Schema.String }, Noop: {} });
export type Message = typeof Message.Type;

export function init(options: Options): Model {
  const defaults =
    options.defaultValue === undefined
      ? []
      : typeof options.defaultValue === 'string'
        ? [options.defaultValue]
        : options.defaultValue;
  const expanded = [...new Set(defaults)].filter((value) =>
    options.items.some((item) => item.value === value),
  );
  return { expanded: options.type === 'multiple' ? expanded : expanded.slice(0, 1) };
}
export function update(model: Model, message: Message, options: Options): Model {
  if (message._tag === 'Noop') return model;
  const item = options.items.find((item) => item.value === message.value);
  if (!item || item.disabled) return model;
  const expanded = model.expanded.includes(item.value);
  if (expanded && options.type !== 'multiple' && options.collapsible === false) return model;
  return {
    expanded: expanded
      ? model.expanded.filter((value) => value !== item.value)
      : options.type === 'multiple'
        ? [...model.expanded, item.value]
        : [item.value],
  };
}
