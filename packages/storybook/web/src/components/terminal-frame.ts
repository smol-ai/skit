import "./terminal-frame.css";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Frame, Row } from "../../../src/atlas/data.ts";

/**
 * A terminal frame drawn as text: a `<pre>` of styled runs in the page's monospace font, so it can
 * be selected, copied, searched and read aloud. ANSI colours 0 to 15 are the `--terminal-<n>`
 * custom properties in terminal-frame.css, which follow the page's light or dark theme. Rows keep the
 * terminal's own wrapping; a frame wider than its box scrolls.
 */
export interface Props {
  /** Names the frame for assistive technology. */
  readonly label: string;
  readonly color?: boolean;
  /** Optional controls share the terminal’s existing border and corner shape. */
  readonly header?: Html;
  /** A smaller preview that clips instead of scrolling, with a still spinner. */
  readonly thumbnail?: boolean;
  /** Draws a copy issue around its text, such as a link with a tooltip. Default: a `<mark>`. */
  readonly mark?: (
    mark: NonNullable<Row["issues"]>[number],
    key: string,
    children: ReadonlyArray<Html | string>,
  ) => Html;
}

// The xterm 256-colour palette past the 16 named colours: a 6×6×6 cube, then 24 greys.
const cube = [0, 95, 135, 175, 215, 255];
const css = (color: NonNullable<Row["runs"][number]["foreground"]>) => {
  if (typeof color === "string") return color;
  if (color < 16) return `var(--terminal-${color})`;
  if (color >= 232) {
    const grey = 8 + (color - 232) * 10;
    return `rgb(${grey} ${grey} ${grey})`;
  }
  const offset = color - 16;
  return `rgb(${cube[Math.floor(offset / 36)]} ${cube[Math.floor(offset / 6) % 6]} ${cube[offset % 6]})`;
};

const span = <Message>(h: HtmlBuilder<Message>, run: Row["runs"][number], text: string) => {
  const foreground = run.foreground === undefined ? undefined : css(run.foreground);
  const background = run.background === undefined ? undefined : css(run.background);
  const color = run.inverse ? (background ?? "var(--terminal-background)") : foreground;
  const fill = run.inverse ? (foreground ?? "var(--terminal-foreground)") : background;
  const classes = [
    run.bold ? "bold" : "",
    run.dim ? "dim" : "",
    run.italic ? "italic" : "",
    run.underline ? "underline" : "",
  ].filter((name) => name !== "");
  return color === undefined && fill === undefined && classes.length === 0
    ? text
    : h.span(
        [
          ...(classes.length > 0 ? [h.Class(classes.join(" "))] : []),
          ...(color === undefined && fill === undefined
            ? []
            : [
                h.Style({
                  ...(color === undefined ? {} : { color }),
                  ...(fill === undefined ? {} : { background: fill }),
                }),
              ]),
        ],
        [text],
      );
};

/** A row's text with each copy issue drawn around the characters it covers. */
const row = <Message>(
  h: HtmlBuilder<Message>,
  { runs, issues = [] }: Row,
  key: string,
  props: Props,
): ReadonlyArray<Html | string> => {
  const offsets = runs.map((_, index) =>
    runs.slice(0, index).reduce((sum, run) => sum + run.text.length, 0),
  );
  const length = runs.reduce((sum, run) => sum + run.text.length, 0);
  // The runs' text from character `from` up to `to`, each piece keeping its run's style.
  const between = (from: number, to: number) =>
    runs.flatMap((run, index) => {
      const start = offsets[index] ?? 0;
      const first = Math.max(from, start);
      const last = Math.min(to, start + run.text.length);
      return first < last
        ? [
            span(
              h,
              props.color === false ? { text: run.text } : run,
              run.text.slice(first - start, last - start),
            ),
          ]
        : [];
    });
  const marked = issues.reduce<{
    readonly at: number;
    readonly nodes: ReadonlyArray<Html | string>;
  }>(
    ({ at, nodes }, mark) => {
      const children = between(mark.start, mark.end);
      const markKey = `${key}-${mark.start}`;
      return {
        at: mark.end,
        nodes: [
          ...nodes,
          ...between(at, mark.start),
          props.mark ? props.mark(mark, markKey, children) : h.mark([h.Class("issue")], children),
        ],
      };
    },
    { at: 0, nodes: [] },
  );
  return [...marked.nodes, ...between(marked.at, length)];
};

export function terminalFrame<Message>(h: HtmlBuilder<Message>, frame: Frame, props: Props): Html {
  const status = frame.status;
  const lines = frame.rows.map((line, index) => row(h, line, `row-${index}`, props));
  const statusLine =
    status === undefined
      ? []
      : [
          [
            h.span(
              [
                h.Class(props.thumbnail ? "spinner still" : "spinner"),
                h.AriaHidden(true),
                h.Style({
                  "--frames": String(status.spinner.length),
                  "--interval": `${status.interval}ms`,
                }),
              ],
              [
                h.span(
                  [],
                  status.spinner.map((glyph, index) => h.span([h.Key(String(index))], [glyph])),
                ),
              ],
            ),
            " ",
            ...row(h, status.row, "status", props),
          ],
        ];
  return terminalShell(
    h,
    props,
    h.pre(
      [
        ...(props.thumbnail ? [] : [h.Tabindex(0)]),
        ...(props.header === undefined
          ? []
          : [h.Style({ borderTopLeftRadius: "0", borderTopRightRadius: "0" })]),
      ],
      [...lines, ...statusLine].flatMap((line, index) => (index === 0 ? line : ["\n", ...line])),
    ),
  );
}

/** Border and inherited corners also frame loading/error content, without fabricating terminal rows. */
export function terminalShell<Message>(
  h: HtmlBuilder<Message>,
  props: Pick<Props, "label" | "header" | "thumbnail">,
  content: Html,
): Html {
  return h.div(
    [
      h.Role("group"),
      h.AriaLabel(props.label),
      h.Class(props.thumbnail ? "terminal-frame thumbnail" : "terminal-frame"),
    ],
    [
      ...(props.header === undefined
        ? []
        : [
            h.div(
              [
                h.Class("border-b-1 border-border bg-muted"),
                h.Style({ borderTopLeftRadius: "inherit", borderTopRightRadius: "inherit" }),
              ],
              [props.header],
            ),
          ]),
      content,
    ],
  );
}
