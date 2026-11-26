import { Button as Primitive } from '@foldkit/ui';
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from 'foldkit/html';
import './styles.css';
export type Variant = 'primary' | 'secondary' | 'tertiary' | 'ghost' | 'destructive';
export type Size = 'default' | 'compact' | 'icon' | 'icon-compact';
export interface Props<Message> {
  readonly children: readonly (Html | string)[];
  readonly onClick?: Message;
  readonly variant?: Variant;
  readonly size?: Size;
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly active?: boolean;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly label?: string;
  readonly leadingIcon?: Html;
  readonly trailingIcon?: Html;
  readonly className?: string;
  readonly attributes?: readonly (Attribute<Message> | ChildAttribute)[];
}
/** Fluid visuals for a button whose interaction may be owned by another
 * Foldkit UI primitive, such as Menu. The caller supplies the native element. */
export function decoration<Message>(props: Props<Message>, h: HtmlBuilder<Message>) {
  const iconOnly = props.size === 'icon' || props.size === 'icon-compact';
  const content = iconOnly
    ? props.children
    : [
        props.leadingIcon ?? null,
        h.span([h.Class('ff-button-label')], props.children),
        props.trailingIcon ?? null,
      ];
  return {
    attributes: [
      h.Disabled(!!props.disabled || !!props.loading),
      h.Class(`ff-button ${props.className ?? ''}`),
      h.DataAttribute('variant', props.variant ?? 'primary'),
      h.DataAttribute('size', props.size ?? 'default'),
      h.DataAttribute('radius', props.radius ?? 'rounded'),
      h.DataAttribute('active', String(!!props.active)),
      h.DataAttribute('loading', String(!!props.loading)),
      h.Attribute('aria-busy', String(!!props.loading)),
      ...(props.label ? [h.AriaLabel(props.label)] : []),
      ...(!iconOnly && props.leadingIcon ? [h.DataAttribute('leading', '')] : []),
      ...(!iconOnly && props.trailingIcon ? [h.DataAttribute('trailing', '')] : []),
      ...(props.attributes ?? []),
    ],
    children: [
      h.span([h.Class('ff-button-background'), h.AriaHidden(true)], []),
      h.span(
        [h.Class('ff-button-content')],
        [
          h.span([h.Class('ff-button-reserved')], content),
          props.loading
            ? h.span(
                [h.Class('ff-button-spinner'), h.AriaHidden(true)],
                [
                  h.svg(
                    [h.Attribute('viewBox', '0 0 24 24'), h.Attribute('fill', 'none')],
                    [
                      h.path(
                        [
                          h.Attribute(
                            'd',
                            'M12 12C14 8.5 19 8.5 19 12C19 15.5 14 15.5 12 12C10 8.5 5 8.5 5 12C5 15.5 10 15.5 12 12Z',
                          ),
                          h.Attribute('stroke', 'currentColor'),
                          h.Attribute('stroke-width', '1.125'),
                          h.Attribute('stroke-linecap', 'round'),
                          h.Attribute('pathLength', '100'),
                        ],
                        [],
                      ),
                    ],
                  ),
                ],
              )
            : null,
        ],
      ),
    ],
  };
}
export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  const visual = decoration(props, h);
  return Primitive.view(
    {
      onClick: props.onClick,
      isDisabled: !!props.disabled || !!props.loading,
      type: props.type ?? 'button',
      toView: ({ button }) => h.button([...button, ...visual.attributes], visual.children),
    },
    h,
  );
}
