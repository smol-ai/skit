import type { Html, HtmlBuilder } from "foldkit/html";

/** Stepper anatomy follows MUI and Ark UI: ordered items, indicators and current-step links. */
export interface Item {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly indicator: Html;
  readonly selected: boolean;
  readonly annotation?: Html | string;
}
export type Row =
  | Item
  | {
      readonly key: string;
      readonly label: string;
      readonly children: readonly Item[];
    };
export interface Props {
  readonly label: string;
  readonly items: readonly Row[];
}

export function view<Message>(props: Props, h: HtmlBuilder<Message>): Html {
  const item = (entry: Item) =>
    h.a(
      [
        h.Href(entry.href),
        ...(entry.selected ? [h.AriaCurrent("step")] : []),
        h.Class(
          `flex min-w-0 items-start gap-2 border-l-2 px-3 py-2 text-body hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring ${entry.selected ? "border-foreground bg-selected text-foreground font-heading" : "border-transparent text-foreground"}`,
        ),
      ],
      [
        h.span([h.Class("shrink-0 text-caption font-body")], [entry.indicator]),
        h.span([h.Class("min-w-0 flex-1 break-words")], [entry.label]),
        ...(entry.annotation
          ? [
              h.span(
                [h.Class("shrink-0 text-caption font-body text-muted-foreground")],
                [entry.annotation],
              ),
            ]
          : []),
      ],
    );
  return h.nav(
    [h.AriaLabel(props.label)],
    [
      h.ol(
        [h.Class("m-0 grid list-none gap-1 p-0")],
        props.items.map((entry) =>
          h.li(
            [h.Key(entry.key)],
            [
              "children" in entry
                ? h.details(entry.children.some((child) => child.selected) ? [h.Open(true)] : [], [
                    h.summary(
                      [
                        h.Class(
                          "cursor-pointer px-3 py-2 text-caption text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring",
                        ),
                      ],
                      [entry.label],
                    ),
                    h.ol(
                      [h.Class("m-0 grid list-none gap-1 p-0 pl-3")],
                      entry.children.map((child) => h.li([h.Key(child.key)], [item(child)])),
                    ),
                  ])
                : item(entry),
            ],
          ),
        ),
      ),
    ],
  );
}
