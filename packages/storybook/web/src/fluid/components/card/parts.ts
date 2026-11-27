import { icon } from '../icons';
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from 'foldkit/html';
export interface PartProps<Message> {
  readonly children: readonly (Html | string | null)[];
  readonly attributes?: readonly (Attribute<Message> | ChildAttribute)[];
}
export const header = <Message>(props: PartProps<Message>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class('ff-card-header'),
      h.DataAttribute('slot', 'card-header'),
      ...(props.attributes ?? []),
    ],
    props.children,
  );
export function title<Message>(props: PartProps<Message>, h: HtmlBuilder<Message>): Html {
  return h.span(
    [h.Class('ff-card-title'), h.DataAttribute('slot', 'card-title'), ...(props.attributes ?? [])],
    [
      h.span([h.Class('ff-card-title-reserve invisible'), h.AriaHidden(true)], props.children),
      h.span([h.Class('ff-card-title-text')], props.children),
    ],
  );
}
export const description = <Message>(props: PartProps<Message>, h: HtmlBuilder<Message>): Html =>
  h.p(
    [
      h.Class('ff-card-description'),
      h.DataAttribute('slot', 'card-description'),
      ...(props.attributes ?? []),
    ],
    props.children,
  );
export const action = <Message>(props: PartProps<Message>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class('ff-card-action'),
      h.DataAttribute('slot', 'card-action'),
      ...(props.attributes ?? []),
    ],
    props.children,
  );
export const content = <Message>(props: PartProps<Message>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class('ff-card-content'),
      h.DataAttribute('slot', 'card-content'),
      ...(props.attributes ?? []),
    ],
    props.children,
  );
export const footer = <Message>(props: PartProps<Message>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class('ff-card-footer'),
      h.DataAttribute('slot', 'card-footer'),
      ...(props.attributes ?? []),
    ],
    props.children,
  );
/** @deprecated The reference keeps this compatibility part but starts cards with a title. */
export const eyebrow = <Message>(props: PartProps<Message>, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class('ff-card-eyebrow'),
      h.DataAttribute('slot', 'card-eyebrow'),
      ...(props.attributes ?? []),
    ],
    props.children,
  );
export interface MediaProps {
  readonly logo?: string | readonly [string, string];
  readonly logoAlt?: string;
  readonly icon?: Html;
  readonly size?: number;
}
export function media<Message>(props: MediaProps, h: HtmlBuilder<Message>): Html | null {
  if (props.logo) {
    const logos = typeof props.logo === 'string' ? [props.logo] : props.logo;
    return h.span(
      [h.Class('ff-card-media'), h.DataAttribute('slot', 'card-media')],
      logos.map((src, index) =>
        h.span(
          [h.Class('ff-card-logo-pair')],
          [
            index > 0 ? h.span([h.Class('ff-card-logo-connector'), h.AriaHidden(true)], []) : null,
            h.img([
              h.Src(src),
              h.Alt(props.logoAlt ?? ''),
              h.Width(String(props.size ?? 22)),
              h.Height(String(props.size ?? 22)),
              h.Class('ff-card-logo'),
              h.Style({ width: `${props.size ?? 22}px`, height: `${props.size ?? 22}px` }),
            ]),
          ],
        ),
      ),
    );
  }
  return props.icon
    ? h.span(
        [
          h.Class('ff-card-media ff-card-media-icon'),
          h.DataAttribute('slot', 'card-media'),
          h.AriaHidden(true),
        ],
        [props.icon],
      )
    : null;
}
export interface ImageProps {
  readonly src: string;
  readonly alt?: string;
}
export const image = <Message>(props: ImageProps, h: HtmlBuilder<Message>): Html =>
  h.img([
    h.Src(props.src),
    h.Alt(props.alt ?? ''),
    h.Class('ff-card-image'),
    h.DataAttribute('slot', 'card-image'),
  ]);
export function feature<Message>(
  props: { readonly title: string; readonly description?: string; readonly icon?: Html },
  h: HtmlBuilder<Message>,
): Html {
  return h.div(
    [h.Class('ff-card-feature'), h.DataAttribute('slot', 'card-feature')],
    [
      props.icon
        ? h.span([h.Class('ff-card-feature-icon'), h.AriaHidden(true)], [props.icon])
        : null,
      h.div(
        [h.Class('ff-card-feature-copy')],
        [
          h.span([h.Class('ff-card-feature-title')], [props.title]),
          props.description
            ? h.span([h.Class('ff-card-feature-description')], [props.description])
            : null,
        ],
      ),
    ],
  );
}
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link';
export interface ButtonProps<Message> {
  readonly children: readonly (Html | string)[];
  readonly onClick?: Message;
  readonly href?: string;
  readonly variant?: ButtonVariant;
  readonly icon?: Html;
  readonly iconPosition?: 'start' | 'end';
  readonly external?: boolean;
  readonly icons?: string;
  readonly disabled?: boolean;
  readonly attributes?: readonly (Attribute<Message> | ChildAttribute)[];
}
export function button<Message>(props: ButtonProps<Message>, h: HtmlBuilder<Message>): Html {
  const position = props.iconPosition ?? (props.external ? 'end' : 'start');
  const attrs = [
    h.Class('ff-card-button'),
    h.DataAttribute('variant', props.variant ?? 'ghost'),
    ...(props.onClick !== undefined ? [h.OnClick(props.onClick)] : []),
    ...(props.attributes ?? []),
  ];
  const children = [
    position === 'start' ? (props.icon ?? null) : null,
    h.span([h.Class('ff-card-button-label')], props.children),
    position === 'end' ? (props.icon ?? null) : null,
    props.external
      ? icon('arrow-right', props.icons, h, {
          attributes: [h.Class('ff-card-external-icon'), h.Attribute('stroke-width', '1.5')],
        })
      : null,
  ];
  return props.href
    ? h.a(
        [
          ...attrs,
          h.Href(props.href),
          ...(props.external ? [h.Target('_blank'), h.Rel('noopener noreferrer')] : []),
        ],
        children,
      )
    : h.button([...attrs, h.Type('button'), h.Disabled(!!props.disabled)], children);
}
