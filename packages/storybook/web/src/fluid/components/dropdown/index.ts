import { Menu as Primitive } from '@foldkit/ui';
import { Option } from 'effect';
import { Submodel } from 'foldkit';
import type { Update } from 'foldkit';
import { childAttributes, type Attribute, type Html, type ChildAttribute } from 'foldkit/html';
import * as Button from '../button';
import { Mounted, rowContent } from '../popup';
import './styles.css';
import type { Selection } from './panel';
export * as Panel from './panel';
export * as Searchable from './searchable';
export * as Tree from './tree';

const behavior = Primitive.create();
export const Model = Primitive.Model;
export type Model = Primitive.Model;
export const Message = Primitive.Message;
export type Message = Primitive.Message;
export type OutMessage = Primitive.OutMessage;
export const init = (config: { readonly id: string }): Model =>
  Primitive.init({ ...config, isAnimated: true, isModal: false });
export function update(
  model: Model,
  message: Message,
  options: { readonly selection?: Selection['mode']; readonly firstEnabledIndex?: number } = {},
): Update.ReturnWithOutMessage<Model, Message, OutMessage> {
  if (message._tag === 'SelectedItem' && options.selection === 'multiple') {
    return {
      model,
      outMessage: Primitive.OutMessage.Selected({ value: message.item, index: message.index }),
    };
  }
  const result = behavior.update(model, message);
  if (!model.isOpen && result.model.isOpen && Option.isNone(result.model.maybeActiveItemIndex)) {
    return {
      ...result,
      model: {
        ...result.model,
        maybeActiveItemIndex:
          (options.firstEnabledIndex ?? 0) < 0
            ? Option.none()
            : Option.some(options.firstEnabledIndex ?? 0),
      },
    };
  }
  return result;
}

export interface Item {
  readonly action?: boolean;
  readonly value: string;
  readonly label: string;
  readonly icon?: Html;
  readonly trailing?: Html;
  readonly disabled?: boolean;
  readonly group?: string;
}
export interface Props {
  readonly anchorTriggerId?: string;
  readonly hideTrigger?: boolean;
  readonly submenu?: boolean;
  readonly surfaceLevel?: number;
  readonly anchorOffset?: number;
  readonly popupAttributes?: readonly ChildAttribute[];
  readonly heldIndex?: number;
  readonly itemToAttributes?: (value: string, index: number) => readonly ChildAttribute[];
  readonly renderItemsHeader?: () => Html;
  readonly renderItemsFooter?: () => Html;
  readonly scrollFade?: boolean;
  readonly selection?: Selection;
  readonly chevron?: boolean;
  readonly items: readonly Item[];
  readonly label: string;
  readonly disabled?: boolean;
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly icons?: string;
  readonly variant?: Button.Variant;
  readonly icon?: Html;
  readonly placement?: Primitive.AnchorConfig['placement'];
  /** Replaces the Button-styled trigger (ColorPicker's format menu). */
  readonly trigger?: {
    readonly attributes: readonly (Attribute<Message> | ChildAttribute)[];
    readonly children: readonly Html[];
  };
  /** false: checked rows mark themselves by background and weight only. */
  readonly checkmarks?: boolean;
  /** Render the popup in place instead of portalling it to the body (inside
   * another popup, so presses in it stay inside that popup). */
  readonly portal?: boolean;
  /** The wrapper's class ("contents" lets a custom trigger sit in its
   * parent's layout, as a sidebar row's own button). */
  readonly rootClassName?: string;
  /** Gap between trigger and popup (default 6). */
  readonly anchorGap?: number;
}
export const view = Submodel.defineView<Model, Message, Props>((model, props, h) => {
  const trigger =
    props.trigger ??
    Button.decoration(
      {
        children: [props.label],
        disabled: props.disabled,
        size: props.size,
        radius: props.radius,
        variant: props.variant ?? 'ghost',
        leadingIcon: props.icon,
        trailingIcon:
          props.chevron === false
            ? undefined
            : h.svg(
                [
                  h.AriaHidden(true),
                  h.Attribute('viewBox', '0 0 24 24'),
                  h.Attribute('fill', 'none'),
                  h.Attribute('stroke', 'currentColor'),
                  h.Attribute('stroke-width', '1.5'),
                  h.Attribute('stroke-linecap', 'round'),
                  h.Attribute('stroke-linejoin', 'round'),
                ],
                [h.path([h.Attribute('d', 'm6 9 6 6 6-6')], [])],
              ),
      },
      h,
    );
  const byValue = new Map(props.items.map((item) => [item.value, item]));
  return h.submodel({
    slotId: 'behavior',
    model,
    view: behavior.view,
    toParentMessage: (message) => message,
    viewInputs: {
      items: props.items.map((item) => item.value),
      itemToSearchText: (value) => byValue.get(value)!.label,
      isItemDisabled: (value) => !!byValue.get(value)?.disabled,
      isButtonDisabled: props.disabled,
      buttonContent: h.span(
        [h.Class(props.trigger ? 'contents' : 'ff-dropdown-trigger-content')],
        trigger.children,
      ),
      buttonAttributes: [
        ...trigger.attributes.flatMap((attribute) =>
          '__childAttribute' in attribute ? [attribute] : childAttributes([attribute]),
        ),
        ...childAttributes(props.hideTrigger ? [h.Hidden(true)] : []),
      ],
      className: props.rootClassName ?? 'ff-dropdown',
      itemsClassName: `ff-popup ff-dropdown-popup ${props.submenu ? 'ff-dropdown-submenu' : ''}`,
      itemsAttributes: [
        ...childAttributes([
          h.DataAttribute('size', props.size ?? 'default'),
          h.DataAttribute('radius', props.radius === 'sharp' ? 'sharp' : 'rounded'),
          h.DataAttribute('selection', props.selection?.mode ?? 'none'),
          h.DataAttribute('surface-level', String(props.surfaceLevel ?? 3)),
          ...(props.heldIndex === undefined
            ? []
            : [h.DataAttribute('held-index', String(props.heldIndex))]),
        ]),
        ...(props.popupAttributes ?? []),
      ],
      renderItemsHeader: props.renderItemsHeader,
      renderItemsFooter: props.renderItemsFooter,
      itemsScrollClassName: `ff-popup-viewport ${props.scrollFade === false ? '' : 'ff-scroll-fade'}`,
      itemsScrollAttributes: childAttributes([h.OnMount(Mounted())]),
      backdropClassName: props.submenu ? 'ff-dropdown-submenu-backdrop' : 'ff-popup-backdrop',
      anchorTriggerId: props.anchorTriggerId,
      anchor: {
        placement: props.placement ?? 'bottom-start',
        gap: props.anchorGap ?? 6,
        offset: props.anchorOffset ?? 0,
        padding: 8,
        portal: props.portal ?? true,
      },
      itemGroupKey: (value) => byValue.get(value)?.group ?? '',
      groupToHeading: (key) =>
        key ? { content: h.span([h.Class('ff-popup-heading')], [key]) } : undefined,
      separatorClassName: 'ff-popup-separator',
      itemToConfig: (value) => {
        const selection = props.selection;
        const checked = byValue.get(value)?.action
          ? undefined
          : selection?.mode === 'single'
            ? selection.value === value
            : selection?.mode === 'multiple'
              ? selection.values.includes(value)
              : undefined;
        return {
          className: 'ff-popup-row',
          attributes: [
            ...childAttributes([
              h.DataAttribute(
                'dropdown-index',
                String(props.items.findIndex((item) => item.value === value)),
              ),
              ...(checked === undefined
                ? []
                : [
                    h.Role(selection?.mode === 'multiple' ? 'menuitemcheckbox' : 'menuitemradio'),
                    h.AriaChecked(checked),
                  ]),
            ]),
            ...(props.itemToAttributes?.(
              value,
              props.items.findIndex((item) => item.value === value),
            ) ?? []),
          ],
          content: rowContent(
            {
              ...byValue.get(value)!,
              check: checked !== undefined && props.checkmarks !== false,
            },
            h,
          ),
        };
      },
    },
  });
});
