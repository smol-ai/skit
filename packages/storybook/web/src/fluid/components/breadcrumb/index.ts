import { Submodel } from 'foldkit';
import {
  childAttributes,
  type Attribute,
  type ChildAttribute,
  type Html,
  type HtmlBuilder,
} from 'foldkit/html';
import * as Dropdown from '../dropdown';
import * as Tooltip from '../tooltip';
import { Tooltip as TooltipPrimitive } from '@foldkit/ui';
import { icon, type IconName } from '../icons';
import { Mounted } from './runtime';
import { init, Model, Message } from './state';
import './styles.css';
export { init, Model, Message, OutMessage, update, collapseCount } from './state';

export interface Item {
  readonly value: string;
  readonly label: string;
  readonly href?: string;
  readonly icon?: IconName;
  /** Keep a name for an icon-only home link. */
  readonly iconOnly?: boolean;
  /** Sibling destinations. A menu step uses a native button. */
  readonly items?: readonly Dropdown.Item[];
}
export interface Props {
  readonly items: readonly Item[];
  readonly label?: string;
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly icons?: string;
  /** Overflow hides middle steps as space runs out. A number fixes the count. */
  readonly collapse?: 'overflow' | number;
  readonly reveal?: 'menu' | 'expand';
  readonly openOnHover?: boolean;
  /** undefined uses the icon library chevron; null removes separators. */
  readonly separator?: string | null;
  readonly className?: string;
  readonly attributes?: readonly Attribute<Message>[];
}

export interface CrumbProps<ParentMessage> {
  readonly children: readonly (Html | string)[];
  readonly separator?: Html | null;
  readonly className?: string;
  readonly attributes?: readonly (Attribute<ParentMessage> | ChildAttribute)[];
}
/** Attribute/content bundle for framework links or another component's trigger.
 * Render exactly one native element with the entire bundle. */
export function decoration<ParentMessage>(
  props: CrumbProps<ParentMessage>,
  h: HtmlBuilder<ParentMessage>,
) {
  return {
    attributes: [
      h.Class(`ff-breadcrumb-target ${props.className ?? ''}`),
      h.DataAttribute('breadcrumb-target', ''),
      ...(props.attributes ?? []),
    ],
    children: [
      ...props.children.map((child) =>
        typeof child === 'string' ? h.span([h.Class('ff-breadcrumb-label')], [child]) : child,
      ),
      props.separator ?? null,
    ],
  };
}

export const view = Submodel.defineView<Model, Message, Props>((model, props, h) => {
  const maxHidden = Math.max(0, props.items.length - 3);
  const hidden = model.expanded
    ? 0
    : Math.min(
        maxHidden,
        props.collapse === 'overflow' ? model.hidden : Math.max(0, props.collapse ?? 0),
      );
  const separator = () =>
    props.separator === null
      ? null
      : h.span(
          [
            h.Class('ff-breadcrumb-separator'),
            h.AriaHidden(true),
            h.DataAttribute('default', String(props.separator === undefined)),
          ],
          [props.separator ?? icon('chevron-right', props.icons, h)],
        );
  const crumb = (
    item: Item,
    key: string,
    current: boolean,
    menuItems = item.items,
    more = false,
  ): Html => {
    const content = decoration(
      {
        children: [
          more
            ? icon('more-horizontal', props.icons, h)
            : item.icon
              ? icon(item.icon, props.icons, h)
              : null,
          ...(more || item.iconOnly ? [] : [item.label]),
        ],
        separator: current ? null : separator(),
        className: current ? 'ff-breadcrumb-page' : '',
        attributes: [
          h.DataAttribute('breadcrumb-key', key),
          ...(more || item.iconOnly ? [h.AriaLabel(item.label)] : []),
        ],
      },
      h,
    );
    const target = (attributes: readonly ChildAttribute[] = []): Html =>
      current
        ? h.span(
            [
              ...content.attributes,
              ...attributes,
              h.Role('link'),
              h.Attribute('aria-current', 'page'),
              h.Attribute('aria-disabled', 'true'),
            ],
            content.children,
          )
        : more && props.reveal === 'expand'
          ? h.button(
              [
                ...content.attributes,
                h.Type('button'),
                h.OnClick(Message.Expanded()),
                ...attributes,
              ],
              content.children,
            )
          : menuItems
            ? h.submodel({
                slotId: `menu-${key}`,
                model: model.menus[key] ?? Dropdown.init({ id: `${model.id}-menu-${key}` }),
                view: Dropdown.view,
                toParentMessage: (message) => Message.MenuMessage({ key, message }),
                viewInputs: {
                  label: item.label,
                  items: menuItems,
                  size: props.size,
                  radius: props.radius,
                  icons: props.icons,
                  placement: 'bottom-start',
                  anchorGap: 4,
                  rootClassName: 'contents',
                  checkmarks: false,
                  trigger: {
                    attributes: [
                      ...content.attributes,
                      ...attributes,
                      h.OnFocus(
                        Message.TooltipMessage({
                          key,
                          message: Tooltip.Message.PrimitiveMessage({
                            message: TooltipPrimitive.Message.FocusedTrigger(),
                          }),
                        }),
                      ),
                      h.OnBlur(
                        Message.TooltipMessage({
                          key,
                          message: Tooltip.Message.PrimitiveMessage({
                            message: TooltipPrimitive.Message.BlurredTrigger(),
                          }),
                        }),
                      ),
                      ...(props.openOnHover ? [h.OnMouseEnter(Message.MenuHovered({ key }))] : []),
                    ].flatMap((attribute) =>
                      '__childAttribute' in attribute ? [attribute] : childAttributes([attribute]),
                    ),
                    children: content.children,
                  },
                },
              })
            : h.a(
                [...content.attributes, h.Href(item.href ?? '#'), ...attributes],
                content.children,
              );
    return more || item.iconOnly
      ? target()
      : h.submodel({
          slotId: `tip-${key}`,
          model: model.tooltips[key] ?? Tooltip.init({ id: `${model.id}-tip-${key}` }),
          view: Tooltip.view,
          toParentMessage: (message) => Message.TooltipMessage({ key, message }),
          viewInputs: {
            content: item.label,
            side: 'bottom',
            radius: props.radius,
            renderTrigger: (attributes) =>
              menuItems
                ? h.span([...attributes, h.Class('ff-breadcrumb-tip-trigger')], [target()])
                : target(attributes),
          },
        });
  };
  const children: Html[] = [];
  props.items.forEach((item, index) => {
    if (index > 0 && index <= hidden) return;
    if (index === 1 + hidden && hidden > 0) {
      const menuItems = props.items
        .slice(1, hidden + 1)
        .map((item) => ({ value: item.value, label: item.label }));
      children.push(
        h.li(
          [h.Key('more'), h.DataAttribute('index', 'more')],
          [
            crumb(
              {
                value: 'more',
                label: props.reveal === 'expand' ? 'Show full path' : `Show ${hidden} hidden steps`,
              },
              'more',
              false,
              menuItems,
              true,
            ),
          ],
        ),
      );
    }
    children.push(
      h.li(
        [h.Key(item.value), h.DataAttribute('index', String(index))],
        [crumb(item, item.value, index === props.items.length - 1)],
      ),
    );
  });
  return h.nav(
    [
      h.Class(`ff-breadcrumb ${props.className ?? ''}`),
      h.AriaLabel(props.label ?? 'Breadcrumb'),
      h.DataAttribute('size', props.size ?? 'default'),
      h.DataAttribute('radius', props.radius ?? 'rounded'),
      h.DataAttribute('count', String(props.items.length)),
      h.OnMount(Mounted()),
      ...(props.attributes ?? []),
    ],
    [h.ol([h.Class('ff-breadcrumb-list')], children)],
  );
});
