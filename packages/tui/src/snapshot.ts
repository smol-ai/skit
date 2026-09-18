import { createCliRenderer, type CliRenderer } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";

export type RendererHarness = {
  renderer: CliRenderer;
  test: TestRendererSetup | null;
};

export async function createRenderer(snapshot?: string, size?: string): Promise<RendererHarness> {
  if (!snapshot) {
    return {
      renderer: await createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" }),
      test: null,
    };
  }

  const [width, height] = (size ?? "").split("x").map(Number);
  const test = await (
    await import("@opentui/core/testing")
  ).createTestRenderer({
    width: width || 140,
    height: height || 38,
  });
  return { renderer: test.renderer, test };
}

export async function writeFrame(test: TestRendererSetup, path: string): Promise<void> {
  await test.waitForVisualIdle();
  await test.flush();
  await Bun.write(path, test.captureCharFrame());
}
