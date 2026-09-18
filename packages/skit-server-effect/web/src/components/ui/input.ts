import { Input as FoldkitInput } from "@foldkit/ui";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { cn } from "../../lib/utils.js";

export type InputConfig<M> = Readonly<{
  id: string;
  label: string;
  description?: string;
  onInput?: (value: string) => M;
  value?: string;
  isDisabled?: boolean;
  isInvalid?: boolean;
  name?: string;
  type?: string;
  placeholder?: string;
  className?: string;
  attributes?: ReadonlyArray<Attribute<M>>;
}>;

export const input = <M>(config: InputConfig<M>, h: HtmlBuilder<M>): Html =>
  FoldkitInput.view<M>(
    {
      id: config.id,
      ...(config.onInput === undefined ? {} : { onInput: config.onInput }),
      ...(config.value === undefined ? {} : { value: config.value }),
      ...(config.isDisabled === undefined ? {} : { isDisabled: config.isDisabled }),
      ...(config.isInvalid === undefined ? {} : { isInvalid: config.isInvalid }),
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.type === undefined ? {} : { type: config.type }),
      ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
      toView: (attributes) =>
        h.div(
          [h.Class("group/field flex w-full flex-col gap-1.5")],
          [
            h.label(
              [
                ...attributes.label,
                h.DataAttribute("slot", "label"),
                h.Class("flex items-center gap-2 text-sm leading-none font-medium select-none"),
              ],
              [config.label],
            ),
            h.input([
              ...attributes.input,
              ...(config.attributes ?? []),
              h.DataAttribute("slot", "input"),
              h.Class(
                cn(
                  "dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive h-8 w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-1 text-base outline-none transition-colors focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 md:text-sm placeholder:text-muted-foreground",
                  config.className,
                ),
              ),
            ]),
            config.description === undefined
              ? h.empty
              : h.span([h.Class("text-sm text-muted-foreground")], [config.description]),
          ],
        ),
    },
    h,
  );
