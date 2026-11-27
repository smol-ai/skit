import { Dialog as Primitive } from '@foldkit/ui';
import { Submodel } from 'foldkit';
import { childAttributes, type ChildAttribute, type Html } from 'foldkit/html';
import * as Button from '../button';
import { icon } from '../icons';
import { DialogPortal } from './portal';
import './styles.css';

export { Model, Message, type OutMessage } from '@foldkit/ui/dialog';
export const init = (config: Omit<Primitive.InitConfig, 'isAnimated'>): Primitive.Model =>
  Primitive.init({ ...config, isAnimated: true });
export const boot = (config: Omit<Primitive.InitConfig, 'isAnimated'>) =>
  Primitive.boot({ ...config, isAnimated: true });
export const update = Primitive.update;
export const open = Primitive.open;
export const close = Primitive.close;
export interface Slots {
  readonly closeButton: readonly ChildAttribute[];
  readonly initialFocus: readonly ChildAttribute[];
}
export interface Props {
  readonly title: string;
  readonly description?: string;
  readonly triggerLabel?: string;
  readonly triggerVariant?: Button.Variant;
  readonly hideTrigger?: boolean;
  readonly width?: 'sm' | 'lg' | 'xl' | '2xl';
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly icons?: string;
  readonly position?: 'center' | 'top';
  readonly surfaceLevel?: number;
  readonly showCloseButton?: boolean;
  readonly hideHeader?: boolean;
  readonly className?: string;
  readonly renderTrigger?: (attributes: readonly ChildAttribute[]) => Html;
  readonly renderContent?: (slots: Slots) => Html;
  readonly renderFooter?: (slots: Slots) => Html;
}
/** Modal behavior, isolation, return focus, and exit retention belong to Foldkit UI. */
export const view = Submodel.defineView<Primitive.Model, Primitive.Message, Props>(
  (model, props, h) =>
    h.submodel({
      slotId: 'behavior',
      model,
      view: Primitive.view,
      toParentMessage: (message) => message,
      viewInputs: {
        hasDescription: !!props.description,
        toView: ({
          dialog,
          backdrop,
          panel,
          title,
          description,
          closeButton,
          initialFocus,
          isVisible,
        }) => {
          const slots: Slots = { closeButton, initialFocus };
          const triggerAttributes = childAttributes([
            h.OnClick(Primitive.Message.RequestedOpen()),
            h.Attribute('aria-haspopup', 'dialog'),
            h.AriaControls(model.id),
            h.Attribute('aria-expanded', String(model.isOpen)),
          ]);
          const trigger = props.hideTrigger
            ? null
            : props.renderTrigger
              ? props.renderTrigger(triggerAttributes)
              : Button.view(
                  {
                    children: [props.triggerLabel ?? 'Open dialog'],
                    variant: props.triggerVariant ?? 'tertiary',
                    size: props.size,
                    radius: props.radius,
                    attributes: triggerAttributes,
                  },
                  h,
                );
          return h.div(
            [h.Class('ff-dialog-root')],
            [
              trigger,
              h.div(
                [h.Class('ff-dialog-portal'), h.OnMount(DialogPortal())],
                [
                  h.dialog(
                    [...dialog, h.Class('ff-dialog')],
                    isVisible
                      ? [
                          h.div([...backdrop, h.Class('ff-dialog-backdrop')], []),
                          h.div(
                            [
                              ...panel,
                              h.Class(`ff-dialog-panel ${props.className ?? ''}`),
                              h.Tabindex(-1),
                              h.DataAttribute('width', props.width ?? 'sm'),
                              h.DataAttribute('size', props.size ?? 'default'),
                              h.DataAttribute('radius', props.radius ?? 'rounded'),
                              h.DataAttribute('position', props.position ?? 'center'),
                              h.DataAttribute(
                                'surface-level',
                                String(
                                  Math.min(8, Math.max(1, Math.round(props.surfaceLevel ?? 5))),
                                ),
                              ),
                            ],
                            [
                              h.div(
                                [
                                  h.Class(
                                    props.hideHeader
                                      ? 'ff-dialog-header ff-dialog-header-hidden'
                                      : 'ff-dialog-header',
                                  ),
                                ],
                                [
                                  h.h2([...title, h.Class('ff-dialog-title')], [props.title]),
                                  props.description
                                    ? h.p(
                                        [...description, h.Class('ff-dialog-description')],
                                        [props.description],
                                      )
                                    : null,
                                ],
                              ),
                              props.renderContent?.(slots) ?? null,
                              props.renderFooter
                                ? h.div([h.Class('ff-dialog-footer')], [props.renderFooter(slots)])
                                : null,
                              props.showCloseButton !== false
                                ? Button.view(
                                    {
                                      children: [icon('x', props.icons, h)],
                                      label: 'Close',
                                      variant: 'ghost',
                                      size: 'icon-compact',
                                      radius: props.radius,
                                      className: 'ff-dialog-close',
                                      attributes: closeButton,
                                    },
                                    h,
                                  )
                                : null,
                            ],
                          ),
                        ]
                      : [],
                  ),
                ],
              ),
            ],
          );
        },
      },
    }),
);
