import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

/** Item / ItemGroup anatomy follows shadcn/ui: content, description and trailing actions. */
export interface Props<Message> {
  readonly key: string;
  readonly title: readonly (Html | string)[];
  readonly description?: readonly (Html | string)[];
  readonly metadata?: readonly (Html | string)[];
  readonly leading?: Html;
  /** Non-interactive row metadata when href is set; independent controls belong in actions. */
  readonly trailing?: readonly (Html | string)[];
  readonly actions?: readonly Html[];
  readonly href?: string;
  /** Accessible link name when the title alone omits important context. */
  readonly label?: string;
  readonly size?: "default" | "compact";
  readonly attributes?: readonly Attribute<Message>[];
}

export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  const content = [
    props.leading ?? null,
    h.div(
      [h.Class("grid min-w-0 flex-1 gap-1")],
      [
        h.strong([h.Class("break-words text-foreground font-heading")], props.title),
        ...(props.description?.length
          ? [h.p([h.Class("m-0 break-words text-muted-foreground")], props.description)]
          : []),
        ...(props.metadata?.length
          ? [
              h.div(
                [
                  h.Class(
                    "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground",
                  ),
                ],
                props.metadata,
              ),
            ]
          : []),
      ],
    ),
    ...(props.trailing?.length
      ? [h.div([h.Class("flex shrink-0 flex-wrap items-center justify-end gap-2")], props.trailing)]
      : []),
  ];
  // Rich titles retain their native text alternative; plain titles give the row a concise name.
  const label =
    props.label ??
    (props.title.every((part) => typeof part === "string") ? props.title.join("") : undefined);
  return h.li(
    [
      h.Key(props.key),
      h.Class(
        props.href === undefined
          ? `flex min-w-0 items-start gap-4 px-3 ${props.size === "compact" ? "py-2" : "py-4"}`
          : "flex min-w-0 items-stretch",
      ),
      ...(props.attributes ?? []),
    ],
    [
      ...(props.href === undefined
        ? content
        : [
            h.a(
              [
                h.Href(props.href),
                ...(label === undefined ? [] : [h.AriaLabel(label)]),
                h.Class(
                  `flex min-w-0 flex-1 items-start gap-4 px-3 text-foreground hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring ${props.size === "compact" ? "py-2" : "py-4"}`,
                ),
              ],
              content,
            ),
          ]),
      ...(props.actions?.length
        ? [h.div([h.Class("flex shrink-0 items-center gap-2 px-3 py-2")], props.actions)]
        : []),
    ],
  );
}

export interface GroupProps<Message> {
  readonly items: readonly Props<Message>[];
  readonly label?: string;
  readonly attributes?: readonly Attribute<Message>[];
}

export function group<Message>(props: GroupProps<Message>, h: HtmlBuilder<Message>): Html {
  return h.ul(
    [
      h.Class("m-0 grid min-w-0 list-none divide-y divide-border p-0"),
      h.Role("list"),
      ...(props.label === undefined ? [] : [h.AriaLabel(props.label)]),
      ...(props.attributes ?? []),
    ],
    props.items.map((item) => view(item, h)),
  );
}
