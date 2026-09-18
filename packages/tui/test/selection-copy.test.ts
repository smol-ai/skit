import { describe, expect, it, vi } from "vitest";
import { copySelectedText, isCopySelectionKey } from "../src/selection-copy";

describe("isCopySelectionKey", () => {
  it("uses y for copy only when text is selected", () => {
    expect(isCopySelectionKey({ name: "y" }, true)).toBe(true);
    expect(isCopySelectionKey({ name: "y" }, false)).toBe(false);
  });

  it("does not confuse a terminal copy chord with the app copy binding", () => {
    expect(isCopySelectionKey({ name: "c", ctrl: true }, true)).toBe(false);
  });
});

describe("copySelectedText", () => {
  it("copies the current OpenTUI selection", () => {
    const copyToClipboardOSC52 = vi.fn(() => true);
    const renderer = {
      getSelection: () => ({ getSelectedText: () => "selected text" }),
      copyToClipboardOSC52,
    };

    expect(copySelectedText(renderer)).toBe(true);
    expect(copyToClipboardOSC52).toHaveBeenCalledWith("selected text");
  });

  it("does not overwrite the clipboard for an empty selection", () => {
    const copyToClipboardOSC52 = vi.fn(() => true);
    const renderer = {
      getSelection: () => ({ getSelectedText: () => "" }),
      copyToClipboardOSC52,
    };

    expect(copySelectedText(renderer)).toBe(false);
    expect(copyToClipboardOSC52).not.toHaveBeenCalled();
  });
});
