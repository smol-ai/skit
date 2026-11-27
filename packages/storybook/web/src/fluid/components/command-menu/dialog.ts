import { Effect, Queue, Schema, Stream } from 'effect';
import { Command, Submodel, type Update } from 'foldkit';
import { defineMessageUnion } from 'foldkit/message';
import * as DialogBase from '../dialog';
import { Message as MenuMessage } from './messages';
import { hasModifier, matchesShortcut, parseShortcut } from './shortcuts';
import * as Menu from './index';

/** The modal shell, as upstream's CommandMenuDialog: a top-anchored dialog
 * whose field takes focus on open. Picking a row closes it; closing resets
 * the menu, because upstream's content unmounts and a reopened palette
 * starts clean. The page binds the opening combo through `shortcut`. */
export const Model = Schema.Struct({ dialog: DialogBase.Model, menu: Menu.Model });
export interface Model extends Schema.Schema.Type<typeof Model> {}
export const init = (config: { readonly id: string }): Model => ({
  dialog: DialogBase.init({ id: `${config.id}-dialog` }),
  menu: Menu.init({ id: config.id }),
});
export const Message = defineMessageUnion({
  Dialog: { message: DialogBase.Message },
  Menu: { message: MenuMessage },
  /** The trigger combo or a trigger button: open when closed, else close. */
  Toggled: {},
  Opened: {},
});
export type Message = typeof Message.Type;
export const OutMessage = Menu.OutMessage;
export type OutMessage = Menu.OutMessage;
export interface UpdateOptions extends Menu.UpdateOptions {
  /** Picking a row closes the dialog. Defaults to true. */
  readonly closeOnSelect?: boolean;
}

export function update(
  model: Model,
  message: Message,
  options: UpdateOptions,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> {
  const dialog = (inner: DialogBase.Message, menu = model.menu) => {
    const result = DialogBase.update(model.dialog, inner);
    const closed = result.outMessage?._tag === 'Closed';
    return {
      model: { dialog: result.model, menu: closed ? Menu.init({ id: menu.id }) : menu },
      commands: (result.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) => Message.Dialog({ message })),
      ),
    };
  };
  switch (message._tag) {
    case 'Dialog':
      return dialog(message.message);
    case 'Toggled':
      return dialog(
        model.dialog.isOpen
          ? DialogBase.Message.RequestedClose()
          : DialogBase.Message.RequestedOpen(),
      );
    case 'Opened':
      return model.dialog.isOpen ? { model } : dialog(DialogBase.Message.RequestedOpen());
    case 'Menu': {
      const result = Menu.update(model.menu, message.message, options);
      const commands = (result.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) => Message.Menu({ message })),
      );
      if (result.outMessage?._tag === 'Selected' && options.closeOnSelect !== false) {
        const closing = dialog(DialogBase.Message.RequestedClose(), result.model);
        return {
          model: closing.model,
          commands: [...commands, ...closing.commands],
          outMessage: result.outMessage,
        };
      }
      return {
        model: { ...model, menu: result.model },
        commands,
        ...(result.outMessage ? { outMessage: result.outMessage } : {}),
      };
    }
  }
}

export interface Props extends Omit<Menu.Props, 'inDialog'> {
  /** Read to screen readers as the dialog's name. */
  readonly title?: string;
  readonly description?: string;
}
export const view = Submodel.defineView<Model, Message, Props>((model, props, h) => {
  const { title, description, ...menu } = props;
  return h.submodel({
    slotId: 'dialog',
    model: model.dialog,
    view: DialogBase.view,
    toParentMessage: (message) => Message.Dialog({ message }),
    viewInputs: {
      title: title ?? 'Command menu',
      description: description ?? 'Search for a command to run.',
      hideTrigger: true,
      hideHeader: true,
      showCloseButton: false,
      width: 'lg',
      position: 'top',
      className: 'ff-command-dialog',
      ...(props.size ? { size: props.size } : {}),
      ...(props.radius ? { radius: props.radius } : {}),
      renderContent: ({ initialFocus }) =>
        h.submodel({
          slotId: 'menu',
          model: model.menu,
          view: Menu.view,
          toParentMessage: (message) => Message.Menu({ message }),
          viewInputs: { ...menu, inDialog: true, inputAttributes: initialFocus },
        }),
    },
  });
});

/** Keydowns that are the combo, for a page Subscription. A bare key stays out
 * of fields; a combo with a modifier fires anywhere, as upstream. `inScope`
 * restricts which presses count (upstream's shortcutScope: focus inside an
 * element), and the listener runs in the capture phase so a claimed combo is
 * handled before page-wide shortcuts such as the site's ⌘K search. */
export function shortcut(
  combo: string,
  inScope: () => boolean = () => true,
): Stream.Stream<KeyboardEvent> {
  const parsed = parseShortcut(combo);
  if (parsed.key === '') return Stream.empty;
  return Stream.callback<KeyboardEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        // preventDefault must run inside the listener: a downstream stage runs
        // after the browser has already acted (⌘P would still print).
        const listener = (event: KeyboardEvent) => {
          if (event.repeat || event.defaultPrevented || !matchesShortcut(event, parsed)) return;
          if (!inScope()) return;
          const target = event.target;
          if (
            !hasModifier(parsed) &&
            target instanceof HTMLElement &&
            (target.closest('input,textarea,select') || target.isContentEditable)
          )
            return;
          event.preventDefault();
          Queue.offerUnsafe(queue, event);
        };
        document.addEventListener('keydown', listener, true);
        return listener;
      }),
      (listener) => Effect.sync(() => document.removeEventListener('keydown', listener, true)),
    ),
  );
}
