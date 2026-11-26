import { Option, Schema } from 'effect';
import { Command, type Update } from 'foldkit';
import { defineMessageUnion } from 'foldkit/message';
import * as Dropdown from '../dropdown';
import * as Tooltip from '../tooltip';

export const Model = Schema.Struct({
  id: Schema.String,
  expanded: Schema.Boolean,
  hidden: Schema.Number,
  hoverKey: Schema.String,
  cuts: Schema.Record(Schema.String, Schema.Boolean),
  menus: Schema.Record(Schema.String, Dropdown.Model),
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
});
export interface Model extends Schema.Schema.Type<typeof Model> {}
export const Message = defineMessageUnion({
  Measured: {
    widths: Schema.Array(Schema.Number),
    available: Schema.Number,
    ellipsis: Schema.Number,
  },
  LabelMeasured: { key: Schema.String, cut: Schema.Boolean },
  Expanded: {},
  MenuHovered: { key: Schema.String },
  MenuMessage: { key: Schema.String, message: Dropdown.Message },
  TooltipMessage: { key: Schema.String, message: Tooltip.Message },
});
export type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({ Selected: { value: Schema.String } });
export type OutMessage = typeof OutMessage.Type;
export const init = ({ id }: { readonly id: string }): Model => ({
  id,
  expanded: false,
  hidden: 0,
  hoverKey: '',
  cuts: {},
  menus: {},
  tooltips: {},
});

/** Preserve the first step, last link and current page; remove from index 1. */
export function collapseCount(widths: readonly number[], available: number, ellipsis = 44): number {
  let total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= available + 0.5) return 0;
  total += ellipsis;
  let hidden = 0;
  while (hidden < widths.length - 3 && total > available + 0.5) total -= widths[++hidden] ?? 0;
  return hidden;
}

export function update(
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> {
  switch (message._tag) {
    case 'Measured': {
      const hidden = collapseCount(message.widths, message.available, message.ellipsis);
      return { model: hidden === model.hidden ? model : { ...model, hidden } };
    }
    case 'LabelMeasured':
      return {
        model:
          !!model.cuts[message.key] === message.cut
            ? model
            : { ...model, cuts: { ...model.cuts, [message.key]: message.cut } },
      };
    case 'Expanded':
      return { model: { ...model, expanded: true } };
    case 'MenuHovered': {
      const result = update(
        model,
        Message.MenuMessage({
          key: message.key,
          message: Dropdown.Message.Opened({ maybeActiveItemIndex: Option.none() }),
        }),
      );
      return { ...result, model: { ...result.model, hoverKey: message.key } };
    }
    case 'MenuMessage': {
      if (
        message.message._tag === 'ClickedButton' &&
        model.hoverKey === message.key &&
        model.menus[message.key]?.isOpen
      )
        return { model: { ...model, hoverKey: '' } };
      const result = Dropdown.update(
        model.menus[message.key] ?? Dropdown.init({ id: `${model.id}-menu-${message.key}` }),
        message.message,
      );
      return {
        model: { ...model, menus: { ...model.menus, [message.key]: result.model } },
        commands: result.commands?.map((command) =>
          Command.mapMessage(command, (message_) =>
            Message.MenuMessage({ key: message.key, message: message_ }),
          ),
        ),
        ...(result.outMessage
          ? { outMessage: OutMessage.Selected({ value: result.outMessage.value }) }
          : {}),
      };
    }
    case 'TooltipMessage': {
      if (
        message.message._tag === 'PrimitiveMessage' &&
        ['EnteredTrigger', 'FocusedTrigger', 'CompletedWaitBeforeShowing'].includes(
          message.message.message._tag,
        ) &&
        (!model.cuts[message.key] || model.menus[message.key]?.isOpen)
      )
        return { model };
      const result = Tooltip.update(
        model.tooltips[message.key] ?? Tooltip.init({ id: `${model.id}-tip-${message.key}` }),
        message.message,
      );
      return {
        model: { ...model, tooltips: { ...model.tooltips, [message.key]: result.model } },
        commands: result.commands?.map((command) =>
          Command.mapMessage(command, (message_) =>
            Message.TooltipMessage({ key: message.key, message: message_ }),
          ),
        ),
      };
    }
  }
}
