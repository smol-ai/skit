import {
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type CliRenderer,
} from "@opentui/core";
import type { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { createInteractionController } from "./interaction";
import type { createViewPrimitives } from "./view";
import { ink, listColors, panelColors, panelTitle, surface, tone } from "./theme";

/** Shared shell views; the interaction controller owns their mode, focus and lifetime. */
export function createShellOverlays(
  renderer: CliRenderer,
  interaction: ReturnType<typeof createInteractionController>,
  view: ReturnType<typeof createViewPrimitives>,
  keymap: ReturnType<typeof createDefaultOpenTuiKeymap>,
) {
  const { box, text, modalWidth, overlayHandle, scrollOverlay } = view;
  function commandField(
    command: ReturnType<typeof keymap.getCommands>[number],
    field: "title" | "description" | "shortcut",
  ): string {
    const value = command[field];
    return typeof value === "string" ? value : "";
  }

  function closePalette(): void {
    interaction.close("palette");
  }

  function runPaletteCommand(name: string): void {
    closePalette();
    keymap.runCommand(name);
  }

  function showDocument(name: string, location: string, content: string): void {
    const overlay = box("skill-document", {
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      border: true,
      backgroundColor: surface.canvas,
      ...panelColors(true),
      title: panelTitle(`SKILL.md | ${name}`),
      flexDirection: "column",
      padding: 1,
    });
    const pathLine = text("skill-document-path", location, { fg: ink.faint, height: 2 });
    const scroll = new ScrollBoxRenderable(renderer, {
      id: "skill-document-scroll",
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
      focusable: true,
      viewportCulling: true,
      verticalScrollbarOptions: { visible: true },
    });
    scroll.add(
      text("skill-document-content", content, {
        width: "100%",
      }),
    );
    overlay.add(pathLine);
    overlay.add(scroll);
    overlay.add(
      text("skill-document-help", "↑↓/PgUp/PgDn scroll   Home/End jump   Esc close", {
        fg: ink.faint,
        height: 1,
      }),
    );
    interaction.open({
      kind: "document",
      view: {
        ...overlayHandle(overlay, () => scroll.focus(), false),
        scroll: (key) => scrollOverlay(scroll, key),
      },
    });
  }

  function openPalette(): void {
    if (interaction.kind === "palette") return;

    const overlay = box("command-palette", {
      position: "absolute",
      ...modalWidth(),
      top: "15%",
      height: "70%",
      zIndex: 100,
      border: true,
      backgroundColor: surface.canvas,
      ...panelColors(true),
      title: panelTitle("command palette"),
      flexDirection: "column",
      padding: 1,
      gap: 1,
    });
    const input = new InputRenderable(renderer, {
      id: "command-palette-input",
      width: "100%",
      placeholder: "Search commands…",
      textColor: ink.strong,
      focusedBackgroundColor: surface.hairline,
      cursorColor: tone.accent,
    });
    const select = new SelectRenderable(renderer, {
      id: "command-palette-results",
      width: "100%",
      flexGrow: 1,
      textColor: ink.DEFAULT,
      descriptionColor: ink.faint,
      ...listColors(true),
      focusedBackgroundColor: "transparent",
      showScrollIndicator: true,
      wrapSelection: true,
    });
    const updateResults = (query: string): void => {
      const commands = keymap.getCommands({
        visibility: "registered",
        search: query,
        searchIn: ["name", "title", "description", "keywords"],
      });
      select.options = commands.map((command) => {
        const shortcut = commandField(command, "shortcut");
        return {
          name: commandField(command, "title"),
          description: `${commandField(command, "description")}${shortcut ? `  |  ${shortcut}` : ""}`,
          value: command.name,
        };
      });
      select.setSelectedIndex(0);
    };

    input.on(InputRenderableEvents.INPUT, (value: string) => updateResults(value));
    input.on(InputRenderableEvents.ENTER, () => select.selectCurrent());
    select.on(
      SelectRenderableEvents.ITEM_SELECTED,
      (_index: number, option: { value?: unknown }) => {
        if (typeof option?.value === "string") runPaletteCommand(option.value);
      },
    );
    updateResults("");
    overlay.add(input);
    overlay.add(select);
    overlay.add(
      text("command-palette-help", "↑↓ browse   enter run   esc close", { fg: ink.faint }),
    );
    interaction.open({
      kind: "palette",
      view: {
        ...overlayHandle(overlay, () => input.focus()),
        move: (direction) => (direction === "up" ? select.moveUp() : select.moveDown()),
      },
    });
  }

  return { showDocument, openPalette };
}
