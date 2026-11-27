import { Schema, Effect } from 'effect';
import { Command, Mount, Submodel, type Update } from 'foldkit';
import { defineMessageUnion } from 'foldkit/message';
import type { ChildAttribute, Html } from 'foldkit/html';
import { Tooltip as Primitive } from '@foldkit/ui';
import './styles.css';
export const Model = Schema.Struct({
  tooltip: Primitive.Model,
  panelPresent: Schema.Boolean,
  version: Schema.Number,
});
export interface Model extends Schema.Schema.Type<typeof Model> {}
export const Message = defineMessageUnion({
  PrimitiveMessage: { message: Primitive.Message },
  ExitFinished: { version: Schema.Number },
});
export type Message = typeof Message.Type;
export type OutMessage = Primitive.OutMessage;
export interface Props {
  readonly content: string;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly sideOffset?: number;
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly renderTrigger: (attributes: readonly ChildAttribute[]) => Html;
  /** Rich content (bold verbs, key chips) in place of the plain string;
   * `content` stays the accessible text. */
  readonly rich?: () => readonly Html[];
  /** Pins the panel open (true) whatever the pointer does — upstream's
   * forceOpen, for a demo's spotlight. */
  readonly forceOpen?: boolean;
  /** Tracks the pointer along one axis while the other stays anchored by
   * `side` — upstream's followCursor, for tall or wide triggers. */
  readonly followCursor?: 'x' | 'y';
}
export const init = (config: Primitive.InitConfig): Model => ({
  tooltip: Primitive.init({ ...config, showDelay: config.showDelay ?? '200 millis' }),
  panelPresent: false,
  version: 0,
});
const FinishExit = Command.define('FluidTooltip.FinishExit', {
  args: { version: Schema.Number },
  messages: [Message.ExitFinished],
  execute: ({ version }) =>
    Effect.sleep('60 millis').pipe(Effect.as(Message.ExitFinished({ version }))),
});
export function update(
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> {
  if (message._tag === 'ExitFinished')
    return {
      model:
        message.version === model.version && !model.tooltip.isOpen
          ? { ...model, panelPresent: false }
          : model,
    };
  const result = Primitive.update(model.tooltip, message.message);
  const changed = result.model.isOpen !== model.tooltip.isOpen;
  const version = model.version + (changed ? 1 : 0);
  return {
    model: {
      tooltip: result.model,
      version,
      panelPresent: result.model.isOpen || model.panelPresent,
    },
    commands: [
      ...(result.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) => Message.PrimitiveMessage({ message })),
      ),
      ...(changed && !result.model.isOpen ? [FinishExit({ version })] : []),
    ],
    outMessage: result.outMessage,
  };
}
/** followCursor: the panel (portaled, found by the primitive's panel id)
 * shifts along the axis by the pointer's distance from the trigger's centre.
 * `translate` composes with the anchor's own positioning. */
const FollowCursor = Mount.define('FluidTooltip.FollowCursor', {
  args: { panelId: Schema.String, axis: Schema.Literals(['x', 'y']) },
  messages: [Schema.Never],
  execute: ({ element, panelId, axis }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let offset = 0;
        const apply = () => {
          const panel = document.getElementById(panelId);
          if (panel) panel.style.translate = axis === 'x' ? `${offset}px 0` : `0 ${offset}px`;
        };
        const move = (event: PointerEvent) => {
          const trigger = element.firstElementChild;
          if (!trigger) return;
          const box = trigger.getBoundingClientRect();
          offset =
            axis === 'x'
              ? event.clientX - (box.left + box.width / 2)
              : event.clientY - (box.top + box.height / 2);
          apply();
        };
        // The panel mounts after the delay: place it as soon as it appears.
        const appear = new MutationObserver(apply);
        appear.observe(document.body, { childList: true, subtree: true });
        // Leaving re-centres it, for a panel pinned open (forceOpen).
        const leave = () => {
          offset = 0;
          apply();
        };
        element.addEventListener('pointermove', move as EventListener);
        element.addEventListener('pointerleave', leave);
        return () => {
          appear.disconnect();
          element.removeEventListener('pointermove', move as EventListener);
          element.removeEventListener('pointerleave', leave);
        };
      }),
      (release) => Effect.sync(release),
    ).pipe(Effect.andThen(Effect.never)),
});

export const view = Submodel.defineView<Model, Message, Props>((model, props, h) =>
  h.submodel({
    slotId: 'behavior',
    model: model.tooltip,
    view: Primitive.view,
    toParentMessage: (message) => Message.PrimitiveMessage({ message }),
    viewInputs: {
      anchor: { placement: props.side ?? 'top', gap: props.sideOffset ?? 8, portal: true },
      isDisabled: props.disabled,
      ariaLabel: props.ariaLabel,
      toView: ({ trigger, panel, isVisible }) =>
        h.span(
          [
            h.Class('ff-tooltip-anchor'),
            ...(props.followCursor
              ? [h.OnMount(FollowCursor({ panelId: `${model.tooltip.id}-panel`, axis: props.followCursor }))]
              : []),
          ],
          [
            props.renderTrigger(trigger),
            model.panelPresent || props.forceOpen
              ? h.div(
                  [
                    ...panel,
                    h.Class('ff-tooltip'),
                    h.DataAttribute('closing', String(!isVisible && !props.forceOpen)),
                    h.DataAttribute('radius', props.radius ?? 'rounded'),
                    h.DataAttribute('side', props.side ?? 'top'),
                  ],
                  [
                    h.div(
                      [h.Class('ff-tooltip-label')],
                      props.rich ? props.rich() : [props.content],
                    ),
                  ],
                )
              : null,
          ],
        ),
    },
  }),
);
