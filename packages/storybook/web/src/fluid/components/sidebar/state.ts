import { Schema } from 'effect';
import { Command, type Update } from 'foldkit';
import { defineMessageUnion } from 'foldkit/message';
import * as Tooltip from '../tooltip';

/* Upstream sidebar-core's provider state. The open flag, mobile drawer,
 * live width, peek overlay and each collapsible group live here; pointer
 * mechanics (drag-resize, hover intent, the springs) live in the runtime,
 * which reports back through these messages. */
export const SIDEBAR_WIDTH = '16rem';
export const SIDEBAR_WIDTH_MOBILE = '18rem';
/** Bare-key toggles: "[" for a left sidebar, "]" for a right one. */
export const SIDEBAR_KEYBOARD_SHORTCUT = '[';
export const SIDEBAR_KEYBOARD_SHORTCUT_RIGHT = ']';
/** Drag-resize clamp (px), and how far past the minimum a drag collapses. */
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_COLLAPSE_SLOP = 56;

export type Side = 'left' | 'right';
export type Variant = 'sidebar' | 'floating' | 'inset';
export type Collapsible = 'offcanvas' | 'none';
export type Peek = 'hover' | 'click' | 'none';

export const Model = Schema.Struct({
  id: Schema.String,
  open: Schema.Boolean,
  openMobile: Schema.Boolean,
  /** Below the provider's mobile breakpoint: the rail becomes a drawer. */
  isMobile: Schema.Boolean,
  /** Live rail width (a CSS length); drag-resize writes px. */
  width: Schema.String,
  /** The collapsed sidebar floating out as an overlay (peek mode). */
  isPeeking: Schema.Boolean,
  /** A rail drag in progress: the width tracks the pointer 1:1. */
  isResizing: Schema.Boolean,
  /** Collapsible groups' open state by key; absent means defaultOpen. */
  groups: Schema.Record(Schema.String, Schema.Boolean),
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
});
export interface Model extends Schema.Schema.Type<typeof Model> {}

export const Message = defineMessageUnion({
  /** Trigger, rail click or the shortcut: drawer on mobile, rail otherwise. */
  Toggled: {},
  OpenSet: { open: Schema.Boolean },
  MobileOpenSet: { open: Schema.Boolean },
  MobileDetected: { mobile: Schema.Boolean },
  /** The rail's drag: a new width, the resize session flag, and the
   * collapse preview past the slop (open: false) or its rescue. */
  Resized: { width: Schema.String },
  ResizeChanged: { resizing: Schema.Boolean },
  PeekChanged: { peeking: Schema.Boolean },
  GroupToggled: { key: Schema.String, defaultOpen: Schema.Boolean },
  Tip: { key: Schema.String, message: Tooltip.Message },
});
export type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  /** The desktop open state changed (persist it, as upstream's cookie). */
  OpenChanged: { open: Schema.Boolean },
});
export type OutMessage = typeof OutMessage.Type;

export interface InitConfig {
  readonly id: string;
  readonly defaultOpen?: boolean;
  readonly width?: string;
}
export const init = (config: InitConfig): Model => ({
  id: config.id,
  open: config.defaultOpen ?? true,
  openMobile: false,
  isMobile: false,
  width: config.width ?? SIDEBAR_WIDTH,
  isPeeking: false,
  isResizing: false,
  groups: {},
  tooltips: {},
});

export const groupOpen = (model: Model, key: string, defaultOpen = true) =>
  model.groups[key] ?? defaultOpen;
export const tipInit = (model: Model, key: string) =>
  Tooltip.init({ id: `${model.id}-tip-${key}` });

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>;
function setOpen(model: Model, open: boolean): Return {
  if (open === model.open) return { model };
  // Pinning open (or collapsing) always ends a peek.
  return {
    model: { ...model, open, isPeeking: false },
    outMessage: OutMessage.OpenChanged({ open }),
  };
}

export function update(model: Model, message: Message): Return {
  switch (message._tag) {
    case 'Toggled':
      return model.isMobile
        ? { model: { ...model, openMobile: !model.openMobile } }
        : setOpen(model, !model.open);
    case 'OpenSet':
      return setOpen(model, message.open);
    case 'MobileOpenSet':
      return { model: { ...model, openMobile: message.open } };
    case 'MobileDetected':
      return {
        model:
          model.isMobile === message.mobile
            ? model
            : { ...model, isMobile: message.mobile, openMobile: false },
      };
    case 'Resized':
      return { model: model.width === message.width ? model : { ...model, width: message.width } };
    case 'ResizeChanged':
      return { model: { ...model, isResizing: message.resizing } };
    case 'PeekChanged':
      return {
        model:
          model.isPeeking === message.peeking || (message.peeking && model.open)
            ? model
            : { ...model, isPeeking: message.peeking },
      };
    case 'GroupToggled':
      return {
        model: {
          ...model,
          groups: {
            ...model.groups,
            [message.key]: !groupOpen(model, message.key, message.defaultOpen),
          },
        },
      };
    case 'Tip': {
      const result = Tooltip.update(
        model.tooltips[message.key] ?? tipInit(model, message.key),
        message.message,
      );
      return {
        model: { ...model, tooltips: { ...model.tooltips, [message.key]: result.model } },
        commands: (result.commands ?? []).map((command) =>
          Command.mapMessage(command, (inner) => Message.Tip({ key: message.key, message: inner })),
        ),
      };
    }
  }
}
