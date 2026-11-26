import { icon } from '../icons';
import { Submodel } from 'foldkit';
import type { Html } from 'foldkit/html';
import { Message, type Model, type Options } from './state';
import { AccordionRuntime } from './runtime';
import './styles.css';

export interface Props extends Options {
  readonly id: string;
  readonly highlight?: 'trigger' | 'item';
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly className?: string;
  readonly icons?: string;
  readonly renderContent?: (value: string) => Html;
  /** Rich trigger content; labels still name items and reserve the default label geometry. */
  readonly renderLabel?: (value: string) => Html;
}
export const view = Submodel.defineView<Model, Message, Props>((model, props, h) => {
  const highlight = props.highlight ?? 'item';
  return h.div(
    [
      h.Id(props.id),
      h.Class(`ff-accordion ${props.className ?? ''}`),
      h.DataAttribute('size', props.size ?? 'default'),
      h.DataAttribute('radius', props.radius ?? 'rounded'),
      h.DataAttribute('accordion-highlight', highlight),
      h.OnMount(AccordionRuntime()),
    ],
    props.items.map((item) => {
      const open = model.expanded.includes(item.value),
        state = open ? 'open' : 'closed';
      const triggerId = `${props.id}-trigger-${encodeURIComponent(item.value)}`,
        panelId = `${props.id}-panel-${encodeURIComponent(item.value)}`;
      const body = props.renderContent ? props.renderContent(item.value) : (item.content ?? '');
      return h.div(
        [
          h.Key(item.value),
          h.Class('ff-accordion-item'),
          h.DataAttribute('accordion-item', ''),
          h.DataAttribute('accordion-highlight', highlight),
          h.DataAttribute('state', state),
          ...(highlight === 'item' ? [h.DataAttribute('accordion-hover', '')] : []),
        ],
        [
          h.h3(
            [h.Class('ff-accordion-heading')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.Id(triggerId),
                  h.Class('ff-accordion-trigger'),
                  h.Disabled(!!item.disabled),
                  h.Attribute('aria-expanded', String(open)),
                  h.Attribute('aria-controls', panelId),
                  h.Attribute(
                    'aria-disabled',
                    String(
                      !!item.disabled ||
                        (open && props.type !== 'multiple' && props.collapsible === false),
                    ),
                  ),
                  h.DataAttribute('accordion-trigger', item.value),
                  h.DataAttribute('state', state),
                  ...(highlight === 'trigger' ? [h.DataAttribute('accordion-hover', '')] : []),
                  h.OnClick(Message.ItemPressed({ value: item.value })),
                ],
                [
                  h.span(
                    [h.Class('ff-accordion-label-grid')],
                    [
                      h.span(
                        [h.Class('ff-accordion-label-ghost'), h.AriaHidden(true)],
                        [item.label],
                      ),
                      h.span(
                        [h.Class('ff-accordion-label'), h.DataAttribute('accordion-label', '')],
                        [props.renderLabel ? props.renderLabel(item.value) : item.label],
                      ),
                    ],
                  ),
                  h.span(
                    [h.Class('ff-accordion-chevron')],
                    [
                      icon('chevron-right', props.icons, h, {
                        attributes: [h.Attribute('stroke-width', open ? '2' : '1.5')],
                      }),
                    ],
                  ),
                ],
              ),
            ],
          ),
          h.div(
            [
              h.Id(panelId),
              h.Role('region'),
              h.Attribute('aria-labelledby', triggerId),
              h.Class('ff-accordion-panel'),
              h.DataAttribute('accordion-panel', ''),
              h.DataAttribute('state', state),
            ],
            [h.div([h.Class('ff-accordion-body')], [body])],
          ),
        ],
      );
    }),
  );
});
