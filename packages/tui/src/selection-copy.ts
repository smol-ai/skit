type SelectionClipboardRenderer = {
  getSelection(): { getSelectedText(): string } | null;
  copyToClipboardOSC52(text: string): boolean;
};

type CopyKey = { name: string; ctrl?: boolean };

export function isCopySelectionKey(key: CopyKey, hasSelection: boolean): boolean {
  return hasSelection && key.name === "y" && !key.ctrl;
}

/** Copy OpenTUI's in-app mouse selection through the terminal clipboard protocol. */
export function copySelectedText(renderer: SelectionClipboardRenderer): boolean {
  const selectedText = renderer.getSelection()?.getSelectedText() ?? "";
  if (!selectedText) return false;

  return renderer.copyToClipboardOSC52(selectedText);
}
