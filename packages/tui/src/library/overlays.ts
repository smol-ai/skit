import {
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import type { PendingLibraryChange } from "@smolai/skit-core/library/session";
import type { Chooser } from "./controller";
import { confirmationPresentation } from "../shell/presentation";
import { ink, listColors, panelColors, panelTitle, surface } from "../shell/theme";
import type { createInteractionController } from "../shell/interaction";
import type { createViewPrimitives } from "../shell/view";

/** Library dialog widgets and their view handles. Interaction owns focus, exclusivity and disposal. */
export function createLibraryOverlays(
  renderer: CliRenderer,
  interaction: ReturnType<typeof createInteractionController>,
  view: ReturnType<typeof createViewPrimitives>,
) {
  const { box, text, modalWidth, overlayHandle, scrollOverlay, isCompact, detailFields } = view;
  function closeChooser(): void {
    interaction.close("chooser");
  }

  function openChooser(chooser: Chooser): void {
    const overlay = box("library-chooser", {
      position: "absolute",
      ...modalWidth(),
      top: "15%",
      height: "70%",
      zIndex: 110,
      border: true,
      backgroundColor: surface.canvas,
      ...panelColors(true),
      title: panelTitle(chooser.title),
      flexDirection: "column",
      padding: 1,
      gap: 1,
    });
    if (chooser.briefing)
      overlay.add(
        new TextRenderable(renderer, {
          id: "library-chooser-briefing",
          content: chooser.briefing,
          fg: ink.faint,
        }),
      );
    const select = new SelectRenderable(renderer, {
      id: "library-chooser-results",
      width: "100%",
      flexGrow: 1,
      textColor: ink.DEFAULT,
      descriptionColor: ink.faint,
      ...listColors(true),
      focusedBackgroundColor: "transparent",
      showScrollIndicator: true,
      wrapSelection: true,
      options: chooser.options.map((option) => ({
        name: option.label,
        description: option.hint ?? "",
        value: option.value,
      })),
    });
    select.on(
      SelectRenderableEvents.ITEM_SELECTED,
      (_index: number, option: { value?: unknown }) => {
        if (typeof option?.value !== "string") return;
        const value = option.value;
        closeChooser();
        void chooser.choose(value);
      },
    );
    overlay.add(select);
    overlay.add(
      text("library-chooser-help", "↑↓ browse   enter select   esc cancel", { fg: ink.faint }),
    );
    interaction.open({
      kind: "chooser",
      view: {
        ...overlayHandle(overlay, () => select.focus()),
        move: (direction) => (direction === "up" ? select.moveUp() : select.moveDown()),
      },
    });
  }

  function closeConfirm(): void {
    interaction.close("confirm");
  }

  /** Every Library write passes through this preview before it is applied. */
  function openConfirm(pending: PendingLibraryChange): void {
    if (!pending) return;
    const model = confirmationPresentation(pending, false, isCompact());
    const overlay = box("library-confirm", {
      position: "absolute",
      ...modalWidth(),
      top: "15%",
      height: "70%",
      zIndex: 120,
      border: true,
      backgroundColor: surface.canvas,
      ...panelColors(true),
      title: panelTitle(model.title),
      flexDirection: "column",
      padding: 1,
      gap: 1,
    });
    const scroll = new ScrollBoxRenderable(renderer, {
      id: "library-confirm-scroll",
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
      contentOptions: { gap: 1, flexShrink: 0 },
    });
    scroll.add(text("library-confirm-summary", model.summary, { fg: ink.strong }));
    const confirmDetails = new TextRenderable(renderer, {
      id: "library-confirm-details",
      content: detailFields(model.fields),
    });
    scroll.add(confirmDetails);
    overlay.add(scroll);
    const confirmHelp = text("library-confirm-help", model.help, {
      fg: ink.faint,
      flexShrink: 0,
    });
    overlay.add(confirmHelp);
    interaction.open({
      kind: "confirm",
      canShowSkills: model.canShowSkills,
      view: {
        ...overlayHandle(overlay, () => scroll.focus()),
        scroll: (key) => scrollOverlay(scroll, key),
        update: (showSkills) => {
          const next = confirmationPresentation(pending, showSkills, isCompact());
          confirmDetails.content = detailFields(next.fields);
          confirmHelp.content = next.help;
        },
      },
    });
  }

  return { openChooser, openConfirm, closeConfirm };
}
