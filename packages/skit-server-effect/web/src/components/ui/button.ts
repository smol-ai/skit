import { Button as FoldkitButton } from "@foldkit/ui";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { cn } from "../../lib/utils.js";

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/80",
  destructive:
    "bg-destructive/10 hover:bg-destructive/20 text-destructive focus-visible:ring-destructive/20",
  outline:
    "border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50",
  link: "text-primary underline-offset-4 hover:underline",
} as const;

const sizes = {
  default: "h-8 gap-1.5 px-2.5",
  sm: "h-7 gap-1 px-2.5 text-[0.8rem]",
  lg: "h-9 gap-1.5 px-2.5",
  icon: "size-8",
} as const;

export type ButtonConfig<M> = Readonly<{
  onClick?: M;
  isDisabled?: boolean;
  type?: "button" | "submit" | "reset";
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  className?: string;
  attributes?: ReadonlyArray<Attribute<M>>;
}>;

export const button = <M>(
  config: ButtonConfig<M>,
  label: Html | string | ReadonlyArray<Html | string>,
  h: HtmlBuilder<M>,
): Html =>
  FoldkitButton.view<M>(
    {
      ...(config.onClick === undefined ? {} : { onClick: config.onClick }),
      ...(config.isDisabled === undefined ? {} : { isDisabled: config.isDisabled }),
      ...(config.type === undefined ? {} : { type: config.type }),
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            h.Class(
              cn(
                "focus-visible:border-ring focus-visible:ring-ring/50 rounded-lg border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 active:translate-y-px inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-all outline-none disabled:pointer-events-none disabled:opacity-50",
                variants[config.variant ?? "default"],
                sizes[config.size ?? "default"],
                config.className,
              ),
            ),
            h.DataAttribute("slot", "button"),
            ...(config.attributes ?? []),
          ],
          Array.isArray(label) ? label : [label],
        ),
    },
    h,
  );
