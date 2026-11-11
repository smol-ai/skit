import stringWidth from "string-width";
import { Data } from "effect";
import { createColors } from "picocolors";
import { terminalText } from "./text.js";
import { compactHome } from "./home-path.js";

/**
 * A run of text inside a Block. Plain strings are prose; the tagged forms say what a span is (a
 * command to type, a quieter aside, a word to stress), never how to draw it.
 */
export type Inline =
  | string
  | { readonly code: string }
  | { readonly url: string }
  | { readonly path: string }
  | { readonly dim: string }
  | { readonly emph: string };

type ChangeAction = "add" | "update" | "remove";

export interface Change {
  readonly action: ChangeAction;
  readonly label: string;
  /** A short fact about the change, such as how many Skills it brings. */
  readonly detail?: string;
  readonly children?: ReadonlyArray<Change>;
}

export interface ListItem {
  readonly text: ReadonlyArray<Inline>;
  readonly detail?: ReadonlyArray<Inline>;
}

export interface Field {
  readonly label: string;
  readonly value: ReadonlyArray<Inline>;
}

interface Column {
  readonly title: string;
  /** Numbers read best aligned to the end of their column. */
  readonly align?: "start" | "end";
}

/**
 * What a presenter says. The renderer owns every glyph, indent, colour and blank line, so two
 * commands that say the same kind of thing look the same.
 */
export type Block = Data.TaggedEnum<{
  /** The title of the whole output. */
  Heading: { readonly text: string };
  /** The outcome of a command or step. */
  Status: {
    readonly tone: "ok" | "info" | "warn" | "error";
    readonly text: ReadonlyArray<Inline>;
  };
  /** Prose. */
  Note: { readonly text: ReadonlyArray<Inline> };
  /** Things named in no particular order, each optionally explained. */
  List: { readonly items: ReadonlyArray<ListItem> };
  /** Facts about one thing, each a label and its value. */
  Fields: { readonly rows: ReadonlyArray<Field> };
  /** Several things compared by the same facts. */
  Table: {
    readonly columns: ReadonlyArray<Column>;
    readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Inline>>>;
  };
  /** Additions, updates and removals, optionally nested. */
  Changes: { readonly title?: string; readonly items: ReadonlyArray<Change> };
  /** Text a program or a person copies exactly, such as a shell script; never wrapped. */
  Verbatim: { readonly text: string };
  /** A titled section; its children sit beneath it with no blank lines between them. */
  Group: { readonly title: string; readonly children: ReadonlyArray<Block> };
}>;

export const Block = Data.taggedEnum<Block>();

const INDENT = "  ";

const tones = {
  ok: { glyph: "✓", paint: "green" },
  info: { glyph: "•", paint: "cyan" },
  warn: { glyph: "!", paint: "yellow" },
  error: { glyph: "✖", paint: "red" },
} as const;

const markers = {
  add: { glyph: "+", paint: "green" },
  update: { glyph: "~", paint: "yellow" },
  remove: { glyph: "-", paint: "red" },
} as const;

const visible = stringWidth;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Draw Blocks for a terminal. Every string is made safe here, so presenters need not be. With a
 * width, prose wraps at spaces and continues under where its text began. Oversized path/prose
 * tokens split between graphemes; code tokens stay exact for copying into a command.
 */
export function renderBlocks(
  blocks: ReadonlyArray<Block>,
  options: { readonly color: boolean; readonly width?: number; readonly home?: string },
): string {
  const color = createColors(options.color);
  const prose = (value: string) => terminalText(compactHome(value, options.home ?? ""));

  const runs = (parts: ReadonlyArray<Inline>) =>
    parts.map((part) =>
      typeof part === "string"
        ? { text: prose(part), paint: (text: string) => text, breakLongToken: true }
        : "code" in part
          ? { text: terminalText(part.code), paint: color.cyan, breakLongToken: false }
          : "url" in part
            ? { text: terminalText(part.url), paint: color.cyan, breakLongToken: false }
            : "path" in part
              ? { text: prose(part.path), paint: color.dim, breakLongToken: true }
              : "dim" in part
                ? { text: prose(part.dim), paint: color.dim, breakLongToken: true }
                : { text: prose(part.emph), paint: color.bold, breakLongToken: true },
    );

  const inline = (parts: ReadonlyArray<Inline>) =>
    runs(parts)
      .map(({ text, paint }) => paint(text))
      .join("");

  /** Keep continuation cells under the value, including paths without spaces. */
  const wrap = (prefix: string, parts: ReadonlyArray<Inline>): string[] => {
    const indent = visible(prefix);
    const room = options.width === undefined ? Infinity : Math.max(options.width - indent, 1);
    const lines: string[][] = [[]];
    let used = 0;
    let space = "";
    type Run = ReturnType<typeof runs>[number];
    const tokens: Array<string | Run[]> = [];
    for (const run of runs(parts)) {
      for (const text of run.text.split(/(\n| +)/)) {
        if (!text) continue;
        if (text === "\n" || text.startsWith(" ")) tokens.push(text);
        else {
          const previous = tokens.at(-1);
          const piece = { ...run, text };
          if (Array.isArray(previous)) previous.push(piece);
          else tokens.push([piece]);
        }
      }
    }
    for (const token of tokens) {
      if (token === "\n") {
        lines.at(-1)!.push(space);
        lines.push([]);
        used = 0;
        space = "";
      } else if (typeof token === "string") space += token;
      else {
        const size = visible(token.map((run) => run.text).join(""));
        if (used > 0 && used + space.length + size > room) {
          lines.push([]);
          used = 0;
          space = "";
        }
        lines.at(-1)!.push(space);
        used += space.length;
        space = "";
        // A style boundary is not a word boundary. Commands/URLs keep their adjacent
        // punctuation, and prose may split only when the complete word is oversized.
        const split = size > room && token.every((run) => run.breakLongToken);
        for (const { text, paint } of token) {
          if (!split) {
            lines.at(-1)!.push(paint(text));
            used += visible(text);
            continue;
          }
          for (const { segment } of graphemes.segment(text)) {
            const cells = visible(segment);
            if (used > 0 && used + cells > room) {
              lines.push([]);
              used = 0;
            }
            lines.at(-1)!.push(paint(segment));
            used += cells;
          }
        }
      }
    }
    lines.at(-1)!.push(space);
    return lines.map(
      (line, index) => `${index === 0 ? prefix : " ".repeat(indent)}${line.join("")}`,
    );
  };

  const change = (item: Change, depth: number): string[] => {
    const marker = markers[item.action];
    return [
      ...wrap(`${INDENT.repeat(depth)}${color[marker.paint](marker.glyph)} `, [
        item.label,
        ...(item.detail === undefined ? [] : [{ dim: ` (${item.detail})` }]),
      ]),
      ...(item.children ?? []).flatMap((child) => change(child, depth + 1)),
    ];
  };

  const table = (
    pad: string,
    columns: ReadonlyArray<Column>,
    rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Inline>>>,
  ): string[] => {
    const cells = [
      columns.map((column) => color.dim(prose(column.title))),
      ...rows.map((row) => columns.map((_, index) => inline(row[index] ?? []))),
    ];
    const widths = columns.map((_, index) => Math.max(...cells.map((row) => visible(row[index]!))));
    // Multiline cells and columns that cannot fit use labeled values, so continuation text cannot
    // appear to belong to another row or column.
    if (
      cells.some((row) => row.some((cell) => cell.includes("\n"))) ||
      (options.width !== undefined &&
        visible(pad) +
          widths.reduce((sum, width) => sum + width, 0) +
          Math.max(0, columns.length - 1) * 2 >
          options.width)
    )
      return rows.flatMap((row, rowIndex) => [
        ...(rowIndex === 0 ? [] : [""]),
        ...columns.flatMap((column, index) =>
          wrap(`${pad}${color.dim(`${prose(column.title)}:`)} `, row[index] ?? []),
        ),
      ]);
    return cells.map((row) =>
      `${pad}${row
        .map((cell, index) => {
          const gap = " ".repeat(widths[index]! - visible(cell));
          return columns[index]!.align === "end" ? gap + cell : cell + gap;
        })
        .join("  ")}`.trimEnd(),
    );
  };

  const block = (value: Block, depth: number): string[] => {
    const pad = INDENT.repeat(depth);
    return Block.$match(value, {
      Heading: ({ text }) => wrap(pad, [{ emph: text }]),
      Status: ({ tone, text }) => {
        const { glyph, paint } = tones[tone];
        return wrap(`${pad}${color[paint](glyph)} `, text);
      },
      Note: ({ text }) => wrap(pad, text),
      List: ({ items }) =>
        items.flatMap((item) => [
          ...wrap(`${pad}${INDENT}`, item.text),
          ...(item.detail === undefined ? [] : wrap(`${pad}${INDENT.repeat(2)}`, item.detail)),
        ]),
      Fields: ({ rows }) => {
        const width = Math.max(...rows.map((row) => visible(prose(row.label))));
        return rows.flatMap((row) =>
          wrap(
            `${pad}${color.dim(prose(row.label) + " ".repeat(width - visible(prose(row.label))))}  `,
            row.value,
          ),
        );
      },
      Table: ({ columns, rows }) => table(pad, columns, rows),
      Verbatim: ({ text }) =>
        terminalText(text)
          .split("\n")
          .map((line) => (line === "" ? "" : pad + line)),
      Changes: ({ title, items }) =>
        title === undefined
          ? items.flatMap((item) => change(item, depth + 1))
          : [...wrap(pad, [title]), ...items.flatMap((item) => change(item, depth + 1))],
      Group: ({ title, children }) => [
        ...wrap(pad, [{ emph: title }]).map(color.cyan),
        ...children.flatMap((child) => block(child, depth + 1)),
      ],
    });
  };

  // A run of Status lines reads as one list of outcomes; every other Block stands apart.
  return blocks
    .map((value, index) => {
      const tight = value._tag === "Status" && blocks[index - 1]?._tag === "Status";
      return `${index === 0 ? "" : tight ? "\n" : "\n\n"}${block(value, 0).join("\n")}`;
    })
    .join("");
}
