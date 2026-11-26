import type { Attribute, ChildAttribute, Html, HtmlBuilder } from 'foldkit/html';
import { icon } from '../icons';
import { Mounted } from './runtime';
import { columns, dividers } from './layout';
import { image, type ImageProps } from './parts';
import './styles.css';
export * from './parts';
export type Orientation = 'card' | 'inline';
export type Border = 'none' | 'outlined';
export interface Props<Message> {
  readonly key?: string;
  /** Compound parts other than the prominent image. */
  readonly children: readonly (Html | string | null)[];
  readonly image?: ImageProps;
  /** Small media outside the body in an inline card. */
  readonly leading?: Html | null;
  readonly onClick?: Message;
  readonly href?: string;
  readonly external?: boolean;
  readonly label?: string;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly dismissible?: boolean;
  readonly dismissOnHover?: boolean;
  readonly onDismiss?: Message;
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly icons?: string;
  readonly border?: Border;
  readonly attributes?: readonly (Attribute<Message> | ChildAttribute)[];
}
export interface GroupProps<Message> {
  readonly cards: readonly Props<Message>[];
  readonly orientation?: Orientation;
  readonly columns?: number;
  readonly border?: Border;
  readonly separated?: boolean;
  readonly fluidHover?: boolean;
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly icons?: string;
  readonly attributes?: readonly (Attribute<Message> | ChildAttribute)[];
}
interface GroupContext {
  readonly orientation: Orientation;
  readonly columns: number;
  readonly count: number;
  readonly selected: number;
  readonly index: number;
  readonly separated: boolean;
  readonly border: Border;
}
function render<Message>(
  props: Props<Message>,
  h: HtmlBuilder<Message>,
  group?: GroupContext,
): Html {
  const orientation = group?.orientation ?? 'card',
    inlineImage = orientation === 'inline' && !!props.image;
  const clickable = !!props.href || props.onClick !== undefined;
  const edges = dividers(
    group?.index ?? 0,
    group?.count ?? 1,
    group?.columns ?? 1,
    -1,
    group?.selected ?? -1,
    !!group && !group.separated,
  );
  const overlayAttrs = [
    h.Class('ff-card-overlay'),
    ...(props.label ? [h.AriaLabel(props.label)] : []),
    ...(props.onClick !== undefined ? [h.OnClick(props.onClick)] : []),
  ];
  const overlay =
    clickable && !props.disabled
      ? props.href
        ? h.a(
            [
              ...overlayAttrs,
              h.Href(props.href),
              ...(props.external ? [h.Target('_blank'), h.Rel('noopener noreferrer')] : []),
            ],
            [],
          )
        : h.button(
            [...overlayAttrs, h.Type('button'), ...(props.selected ? [h.AriaPressed('true')] : [])],
            [],
          )
      : null;
  const rest = [...(props.leading ? [props.leading] : []), ...props.children];
  const body = [
    ...(props.image ? [image(props.image, h)] : []),
    ...(inlineImage ? [h.div([h.Class('ff-card-inline-image-body')], rest)] : rest),
  ];
  return h.div(
    [
      h.Key(props.key ?? String(group?.index ?? 'card')),
      h.Class('ff-card'),
      h.DataAttribute('slot', 'card'),
      h.DataAttribute('card-index', String(group?.index ?? 0)),
      h.DataAttribute('orientation', orientation),
      h.DataAttribute('clickable', String(clickable)),
      h.DataAttribute('selected', String(!!props.selected)),
      h.DataAttribute('size', props.size ?? 'default'),
      h.DataAttribute('radius', props.radius ?? 'rounded'),
      h.DataAttribute('grouped', String(!!group)),
      h.DataAttribute('tile', String(!group || (group.separated && group.border === 'outlined'))),
      h.DataAttribute(
        'frame',
        String(
          group ? group.separated && group.border === 'outlined' : props.border === 'outlined',
        ),
      ),
      h.DataAttribute('image', String(!!props.image)),
      h.DataAttribute('dismissible', String(!!props.dismissible)),
      h.DataAttribute('dismiss-hover', String(props.dismissOnHover !== false)),
      h.DataAttribute('divider-bottom', String(edges.bottom)),
      h.DataAttribute('divider-right', String(edges.right)),
      ...(props.disabled ? [h.AriaDisabled(true)] : []),
      ...(props.attributes ?? []),
    ],
    [
      props.selected ? h.span([h.Class('ff-card-selected'), h.AriaHidden(true)], []) : null,
      h.span([h.Class('ff-card-divider-bottom'), h.AriaHidden(true)], []),
      h.span([h.Class('ff-card-divider-right'), h.AriaHidden(true)], []),
      overlay,
      ...body,
      props.dismissible
        ? h.button(
            [
              h.Type('button'),
              h.Class('ff-card-dismiss'),
              h.AriaLabel('Dismiss'),
              ...(props.onDismiss !== undefined ? [h.OnClick(props.onDismiss)] : []),
            ],
            [icon('x', props.icons, h)],
          )
        : null,
    ],
  );
}
export const view = <Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html =>
  render(props, h);
export function group<Message>(props: GroupProps<Message>, h: HtmlBuilder<Message>): Html {
  const width = columns(props.columns),
    selected = props.cards.findIndex((card) => card.selected);
  return h.div(
    [
      h.Class('ff-card-group'),
      h.DataAttribute('slot', 'card-group'),
      h.DataAttribute('orientation', props.orientation ?? 'card'),
      h.DataAttribute('columns', String(width)),
      h.DataAttribute('selected-index', String(selected)),
      h.DataAttribute('border', props.border ?? 'none'),
      h.DataAttribute('separated', String(!!props.separated)),
      h.DataAttribute('fluid-hover', String(props.fluidHover !== false)),
      h.DataAttribute('radius', props.radius ?? 'rounded'),
      h.Style({ gridTemplateColumns: `repeat(${width},minmax(0,1fr))` }),
      h.OnMount(Mounted()),
      ...(props.attributes ?? []),
    ],
    props.cards.map((card, index) =>
      render(
        {
          ...card,
          size: card.size ?? props.size,
          radius: card.radius ?? props.radius,
          icons: card.icons ?? props.icons,
        },
        h,
        {
          orientation: props.orientation ?? 'card',
          columns: width,
          count: props.cards.length,
          selected,
          index,
          separated: !!props.separated,
          border: props.border ?? 'none',
        },
      ),
    ),
  );
}
