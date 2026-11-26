import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

/** Page header anatomy follows Atlassian: title, supporting content, metadata and actions. */
export interface Props<Message> {
  readonly title: readonly (Html | string)[];
  readonly description?: readonly (Html | string)[];
  readonly children?: readonly (Html | string)[];
  readonly metadata?: readonly (Html | string)[];
  readonly actions?: readonly Html[];
  readonly attributes?: readonly Attribute<Message>[];
}

export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  return h.header(
    [h.Class("grid min-w-0 gap-4"), ...(props.attributes ?? [])],
    [
      h.div(
        [h.Class("flex min-w-0 flex-wrap items-start justify-between gap-4")],
        [
          h.div(
            [h.Class("grid min-w-0 flex-1 gap-2")],
            [
              h.h1(
                [h.Class("m-0 break-words text-display font-display text-foreground")],
                props.title,
              ),
              ...(props.description?.length
                ? [h.p([h.Class("m-0 max-w-prose text-muted-foreground")], props.description)]
                : []),
            ],
          ),
          ...(props.actions?.length
            ? [h.div([h.Class("flex shrink-0 flex-wrap items-center gap-2")], props.actions)]
            : []),
        ],
      ),
      ...(props.children ?? []),
      ...(props.metadata?.length
        ? [
            h.div(
              [
                h.Class(
                  "flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-caption text-muted-foreground",
                ),
              ],
              props.metadata,
            ),
          ]
        : []),
    ],
  );
}
