import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import { Terminal, type IBufferCell } from "@xterm/headless";

const foreground = "#d8dee9";
const background = "#171c26";
const canvas = "#10141d";
const border = "#30394a";
const palette = [
  "#242b38",
  "#ef8b91",
  "#a3cf98",
  "#e8c78a",
  "#91b9ed",
  "#c4a2e8",
  "#88cbd0",
  "#d8dee9",
  "#8590a3",
  "#ff9ca2",
  "#b7e3ac",
  "#f5d69c",
  "#a7ccff",
  "#d7b8fa",
  "#a0dfe4",
  "#f4f6fa",
];
const require = createRequire(import.meta.url);
const font = (name: string) => require.resolve(`dejavu-fonts-ttf/ttf/${name}`);
const terminalFonts = [
  { file: font("DejaVuSansMono.ttf"), weight: 400 },
  { file: font("DejaVuSansMono-Bold.ttf"), weight: 700 },
];
// DejaVu Sans Mono lacks the braille spinner.
const fallbackFont = font("DejaVuSans.ttf");

// DejaVu Sans Mono: 1233-unit advance, 1901 ascent and 483 descent per 2048-unit em.
const fontSize = 15;
const cellWidth = (fontSize * 1233) / 2048;
const lineHeight = 24;
const baseline = (lineHeight - (2384 / 2048) * fontSize) / 2 + (1901 / 2048) * fontSize;
const margin = 24;
const paddingX = 32;
const headerPaddingY = 20;
const bodyPaddingY = 28;

type Run = {
  readonly column: number;
  readonly cells: ReadonlyArray<{ readonly column: number; readonly char: string }>;
  readonly width: number;
  readonly fill: string;
  readonly background: string | undefined;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
};

const cube = [0, 95, 135, 175, 215, 255];
const hex = (...channels: ReadonlyArray<number>) =>
  `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
const paletteColor = (index: number): string => {
  if (index < 16) return palette[index]!;
  if (index >= 232) return hex(...Array(3).fill(8 + (index - 232) * 10));
  const offset = index - 16;
  return hex(cube[Math.floor(offset / 36)]!, cube[Math.floor(offset / 6) % 6]!, cube[offset % 6]!);
};

function cellColors(cell: IBufferCell) {
  const fg = cell.isFgRGB()
    ? `#${cell.getFgColor().toString(16).padStart(6, "0")}`
    : cell.isFgPalette()
      ? paletteColor(cell.getFgColor())
      : undefined;
  const bg = cell.isBgRGB()
    ? `#${cell.getBgColor().toString(16).padStart(6, "0")}`
    : cell.isBgPalette()
      ? paletteColor(cell.getBgColor())
      : undefined;
  return cell.isInverse()
    ? { fill: bg ?? background, background: fg ?? foreground }
    : { fill: fg ?? foreground, background: bg };
}

/** Lays ANSI text onto an exact terminal grid and groups equally styled cells. */
async function layout(ansi: string, columns: number): Promise<ReadonlyArray<ReadonlyArray<Run>>> {
  const terminal = new Terminal({
    cols: columns,
    rows: 1,
    scrollback: 100_000,
    convertEol: true,
    // The buffer API is still marked proposed in the headless build.
    allowProposedApi: true,
  });
  await new Promise<void>((done) => terminal.write(ansi.trimEnd(), done));
  const buffer = terminal.buffer.active;
  const rows: Array<Array<Run>> = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)!;
    const runs: Array<Run> = [];
    for (let x = 0; x < columns; x++) {
      const cell = line.getCell(x)!;
      if (cell.getWidth() === 0) continue;
      const style = {
        ...cellColors(cell),
        bold: cell.isBold() !== 0,
        dim: cell.isDim() !== 0,
        italic: cell.isItalic() !== 0,
        underline: cell.isUnderline() !== 0,
      };
      const char = cell.getChars() || " ";
      const previous = runs.at(-1);
      if (
        previous &&
        previous.column + previous.width === x &&
        previous.fill === style.fill &&
        previous.background === style.background &&
        previous.bold === style.bold &&
        previous.dim === style.dim &&
        previous.italic === style.italic &&
        previous.underline === style.underline
      ) {
        runs[runs.length - 1] = {
          ...previous,
          cells: [...previous.cells, { column: x, char }],
          width: previous.width + cell.getWidth(),
        };
      } else {
        runs.push({ column: x, cells: [{ column: x, char }], width: cell.getWidth(), ...style });
      }
    }
    rows.push(runs);
  }
  terminal.dispose();
  while (rows.at(-1)?.every((run) => !run.background && run.cells.every((c) => c.char === " ")))
    rows.pop();
  return rows;
}

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function drawRows(rows: ReadonlyArray<ReadonlyArray<Run>>, left: number, top: number): string {
  return rows
    .flatMap((runs, row) =>
      runs.flatMap((run) => {
        const x = left + run.column * cellWidth;
        const y = top + row * lineHeight;
        const glyphs = run.cells.filter(({ char }) => char !== " ");
        const opacity = run.dim ? ` fill-opacity="0.55"` : "";
        return [
          run.background &&
            `<rect x="${x}" y="${y}" width="${run.width * cellWidth}" height="${lineHeight}" fill="${run.background}"/>`,
          glyphs.length > 0 &&
            `<text x="${glyphs.map(({ column }) => left + column * cellWidth).join(" ")}" y="${y + baseline}" fill="${run.fill}"${opacity}${run.bold ? ` font-weight="700"` : ""}${run.italic ? ` font-style="italic"` : ""}>${escape(glyphs.map(({ char }) => char).join(""))}</text>`,
          run.underline &&
            `<rect x="${x}" y="${y + baseline + 2}" width="${run.width * cellWidth}" height="1" fill="${run.fill}"${opacity}/>`,
        ].filter((part): part is string => typeof part === "string");
      }),
    )
    .join("");
}

/** Owns the palette, fonts, terminal grid, and card chrome for one exported image. */
export async function renderImage(options: {
  ansi: string;
  command?: string;
  columns: number;
}): Promise<{ svg: string; png: Buffer }> {
  const body = await layout(options.ansi, options.columns);
  const header = options.command
    ? await layout(`\x1b[32m❯\x1b[39m \x1b[97m${options.command}`, options.columns)
    : [];
  const cardWidth = options.columns * cellWidth + 2 * paddingX;
  const headerHeight = header.length > 0 ? header.length * lineHeight + 2 * headerPaddingY : 0;
  const cardHeight = headerHeight + body.length * lineHeight + 2 * bodyPaddingY;
  const width = cardWidth + 2 * margin;
  const height = cardHeight + 2 * margin;
  const content = [
    `<rect width="${width}" height="${height}" fill="${canvas}"/>`,
    `<rect x="${margin + 0.5}" y="${margin + 0.5}" width="${cardWidth - 1}" height="${cardHeight - 1}" rx="12" fill="${background}" stroke="${border}"/>`,
    header.length > 0 &&
      `<rect x="${margin + 1}" y="${margin + headerHeight}" width="${cardWidth - 2}" height="1" fill="${border}"/>`,
    drawRows(header, margin + paddingX, margin + headerPaddingY),
    drawRows(body, margin + paddingX, margin + headerHeight + bodyPaddingY),
  ]
    .filter((part): part is string => typeof part === "string")
    .join("");
  const svg = (style: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="DejaVu Sans Mono, DejaVu Sans, monospace" font-size="${fontSize}">${style}${content}</svg>`;
  const png = new Resvg(svg(""), {
    fitTo: { mode: "zoom", value: 2 },
    font: {
      fontFiles: [...terminalFonts.map(({ file }) => file), fallbackFont],
      loadSystemFonts: false,
      defaultFontFamily: "DejaVu Sans Mono",
    },
  })
    .render()
    .asPng();
  // The SVG embeds only the terminal font; fallback glyphs keep their cell positions.
  const fontFaces = terminalFonts
    .map(
      ({ file, weight }) =>
        `@font-face{font-family:"DejaVu Sans Mono";font-weight:${weight};src:url(data:font/ttf;base64,${readFileSync(file).toString("base64")}) format("truetype")}`,
    )
    .join("");
  return { svg: svg(`<style>${fontFaces}</style>`), png };
}
