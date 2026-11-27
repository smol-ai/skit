import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

/** A semantic Data List, following the label/value anatomy in Radix Themes. */
export interface Props<Message> {
  readonly items: readonly {
    readonly key: string;
    readonly label: readonly (Html | string)[];
    readonly value: readonly (Html | string)[];
  }[];
  readonly orientation?: "horizontal" | "vertical";
  readonly size?: "default" | "compact";
  readonly label?: string;
  readonly attributes?: readonly Attribute<Message>[];
}

export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  return h.dl(
    [
      h.Class(
        `m-0 grid min-w-0 gap-x-6 ${props.size === "compact" ? "gap-y-2" : "gap-y-3"} ${props.orientation === "vertical" ? "" : "sm:grid-cols-[max-content_minmax(0,1fr)]"}`,
      ),
      ...(props.label === undefined ? [] : [h.AriaLabel(props.label)]),
      ...(props.attributes ?? []),
    ],
    props.items.map((item) =>
      h.div(
        [
          h.Key(item.key),
          h.Class(
            props.orientation === "vertical"
              ? "grid min-w-0 gap-1"
              : "grid min-w-0 gap-1 sm:contents",
          ),
        ],
        [
          h.dt([h.Class("m-0 text-muted-foreground")], item.label),
          h.dd([h.Class("m-0 min-w-0 break-words text-foreground")], item.value),
        ],
      ),
    ),
  );
}
