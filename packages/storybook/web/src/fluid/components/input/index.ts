import { Input as Primitive } from '@foldkit/ui';
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from 'foldkit/html';
import { icon } from '../icons';
import { Mounted } from './runtime';
import './styles.css';
export interface Props<Message> {
  readonly id: string;
  readonly value?: string;
  readonly onInput?: (value: string) => Message;
  readonly onFiles?: (files: readonly File[]) => Message;
  readonly type?: string;
  readonly placeholder?: string;
  readonly name?: string;
  readonly ariaLabel?: string;
  readonly describedBy?: string;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly invalid?: boolean;
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number | 'any';
  readonly maxLength?: number;
  readonly autoComplete?: string;
  readonly accept?: string;
  readonly multiple?: boolean;
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly icons?: string;
  readonly attributes?: readonly (Attribute<Message> | ChildAttribute)[];
}
export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  const type = props.type ?? 'text';
  return Primitive.view(
    {
      id: props.id,
      type,
      value: type === 'file' ? undefined : props.value,
      onInput: type === 'file' ? undefined : props.onInput,
      placeholder: props.placeholder,
      name: props.name,
      isDisabled: props.disabled,
      isReadOnly: props.readOnly,
      isInvalid: props.invalid,
      toView: ({ input }) => {
        const control = h.input([
          ...input,
          h.Class('ff-input'),
          h.DataAttribute('slot', 'input'),
          h.DataAttribute('size', props.size ?? 'default'),
          h.DataAttribute('radius', props.radius ?? 'rounded'),
          ...(props.ariaLabel ? [h.AriaLabel(props.ariaLabel)] : []),
          ...(props.describedBy ? [h.AriaDescribedBy(props.describedBy)] : []),
          ...(props.required ? [h.Required(true)] : []),
          ...(props.min !== undefined ? [h.Min(String(props.min))] : []),
          ...(props.max !== undefined ? [h.Max(String(props.max))] : []),
          ...(props.step !== undefined ? [h.Step(String(props.step))] : []),
          ...(props.maxLength !== undefined ? [h.Maxlength(props.maxLength)] : []),
          ...(props.autoComplete ? [h.Autocomplete(props.autoComplete)] : []),
          ...(props.accept ? [h.Accept(props.accept)] : []),
          ...(props.multiple ? [h.Multiple(true)] : []),
          ...(props.onFiles ? [h.OnFileChange(props.onFiles)] : []),
          ...(props.attributes ?? []),
        ]);
        if (type !== 'file' && type !== 'number') return control;
        return h.span(
          [
            h.Class('ff-input-wrapper'),
            h.DataAttribute('kind', type),
            h.DataAttribute('size', props.size ?? 'default'),
            h.DataAttribute('radius', props.radius ?? 'rounded'),
            h.OnMount(Mounted()),
          ],
          [
            type === 'file'
              ? h.span(
                  [h.Class('ff-input-file-icon'), h.AriaHidden(true)],
                  [icon('file', props.icons, h)],
                )
              : null,
            control,
            type === 'number'
              ? h.span(
                  [h.Class('ff-input-steps')],
                  ([-1, 1] as const).map((direction) =>
                    h.button(
                      [
                        h.Type('button'),
                        h.Tabindex(-1),
                        h.Class('ff-input-step'),
                        h.DataAttribute('input-step', String(direction)),
                        h.AriaLabel(direction === 1 ? 'Increase' : 'Decrease'),
                        h.Disabled(!!props.disabled || !!props.readOnly),
                      ],
                      [icon(direction === 1 ? 'plus' : 'minus', props.icons, h)],
                    ),
                  ),
                )
              : null,
          ],
        );
      },
    },
    h,
  );
}
