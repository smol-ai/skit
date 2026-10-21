import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import Convert from "ansi-to-html";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const foreground = "#d8dee9";
const background = "#171c26";
const colors = [
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

/** Owns HTML escaping, palette, embedded fonts, sizing, and browser lifetime. */
export async function exportImage(options: {
  output: string;
  ansi: string;
  command?: string;
  columns: number;
}): Promise<void> {
  const font = async (weight: number) => {
    const path = require.resolve(
      `@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff2`,
    );
    return `@font-face{font-family:Terminal; font-style:normal; font-weight:${weight};src:url(data:font/woff2;base64,${(await readFile(path)).toString("base64")}) format('woff2');}`;
  };
  const converter = () => new Convert({ fg: foreground, bg: background, colors, escapeXML: true });
  const body = converter().toHtml(options.ansi.trimEnd());
  const heading = options.command
    ? `<header><span class="prompt">❯</span> ${converter().toHtml(options.command)}</header>`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${await font(400)} ${await font(700)}
*{box-sizing:border-box} body{margin:0;background:transparent;color:${foreground};font:15px/1.65 Terminal,monospace;font-variant-ligatures:none}
main{display:inline-block;padding:24px;background:#10141d}
article{width:calc(${options.columns}ch + 64px);background:${background};border:1px solid #30394a;border-radius:12px;overflow:hidden}
header{padding:20px 32px;border-bottom:1px solid #30394a;color:#f4f6fa;white-space:pre-wrap;overflow-wrap:anywhere}.prompt{color:#a3cf98}
pre{margin:0;padding:28px 32px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit} i{font-style:normal}
</style></head><body><main><article>${heading}<pre>${body}</pre></article></main></body></html>`;
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 2400, height: 1000 },
      deviceScaleFactor: 2,
    });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.locator("main").screenshot({ path: output, type: "png", omitBackground: true });
    await writeFile(output.replace(/\.png$/i, ".html"), html);
  } finally {
    await browser.close();
  }
}
