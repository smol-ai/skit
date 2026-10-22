import { describe, expect, it } from "vitest";
import { terminalData, terminalText } from "../src/presentation/terminal-text.js";

// OSC 52 asks the terminal to replace the clipboard; CSI 2J clears the screen.
const clipboard = "\u001b]52;c;c2tpdC1hdWRpdC1tYXJrZXI=\u0007";
const c1Csi = "\u009b2J";

describe("terminal text", () => {
  it("removes C0 and C1 controls but keeps newlines, tabs and Unicode", () => {
    expect(terminalText(`review${clipboard}\tskill\r\n${c1Csi}café 技能`)).toBe(
      "review]52;c;c2tpdC1hdWRpdC1tYXJrZXI=\tskill\n2Jcafé 技能",
    );
  });

  it("cleans every string in contract data, keys included, keeping other values", () => {
    expect(
      terminalData({
        machine: {
          instances: [{ name: `review${clipboard}`, paths: [`/repo/${c1Csi}`], count: 2 }],
          [`by${clipboard}`]: { enabled: true, missing: null },
        },
      }),
    ).toEqual({
      machine: {
        instances: [
          { name: "review]52;c;c2tpdC1hdWRpdC1tYXJrZXI=", paths: ["/repo/2J"], count: 2 },
        ],
        "by]52;c;c2tpdC1hdWRpdC1tYXJrZXI=": { enabled: true, missing: null },
      },
    });
  });
});
