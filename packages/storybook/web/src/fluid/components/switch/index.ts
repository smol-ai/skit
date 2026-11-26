import { Switch as Primitive } from '@foldkit/ui';
import { Mount } from 'foldkit';
import { type Html, type HtmlBuilder } from 'foldkit/html';
import { Mounted } from './runtime';
import './styles.css';

export interface Props<Message> {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onToggle: (checked: boolean) => Message;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly name?: string;
  readonly value?: string;
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly size?: 'default' | 'compact';
  readonly className?: string;
}

export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  return Primitive.view(
    {
      id: props.id,
      isChecked: props.checked,
      onToggle: props.onToggle,
      isDisabled: props.disabled,
      isReadOnly: props.readOnly,
      name: props.name,
      value: props.value,
      toView: ({ button, hiddenInput }) =>
        h.div(
          [],
          [
            h.button(
              [
                ...button,
                h.Id(props.id),
                h.Disabled(!!props.disabled),
                h.Class(`ff-switch ${props.className ?? ''}`),
                h.DataAttribute('size', props.size ?? 'default'),
                h.DataAttribute('radius', props.radius ?? 'rounded'),
                h.OnMount(
                  Mount.mapMessage(Mounted(), (message) => props.onToggle(message.checked)),
                ),
              ],
              [
                h.span(
                  [h.Class('ff-switch-track'), h.AriaHidden(true)],
                  [h.span([h.Class('ff-switch-thumb')], [])],
                ),
                h.span(
                  [h.Id(Primitive.labelId(props.id)), h.Class('ff-switch-label')],
                  [props.label],
                ),
              ],
            ),
            props.name
              ? h.input([...hiddenInput, h.Disabled(!!props.disabled || !props.checked)])
              : null,
          ],
        ),
    },
    h,
  );
}
