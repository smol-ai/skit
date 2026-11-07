import {
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { chip, detailsBlock, ink, kv, tone } from "./theme";
import type { AuditItem, DetailField } from "./presentation";
import type { Overlay, ScrollKey } from "./interaction";

/** Existing shell widget/layout helpers, bound once to this renderer. */
export function createViewPrimitives(renderer: CliRenderer) {
  function box(
    id: string,
    options: ConstructorParameters<typeof BoxRenderable>[1] = {},
  ): BoxRenderable {
    return new BoxRenderable(renderer, {
      id,
      backgroundColor: "transparent",
      ...options,
    });
  }

  function text(
    id: string,
    content: string,
    options: Omit<ConstructorParameters<typeof TextRenderable>[1], "content"> = {},
  ): TextRenderable {
    return new TextRenderable(renderer, {
      id,
      content,
      fg: ink.DEFAULT,
      ...options,
    });
  }

  function statusColor(status: AuditItem["status"]): string {
    return {
      clear: tone.success,
      warning: tone.warning,
      error: tone.danger,
    }[status];
  }

  function detailFields(fields: readonly DetailField[]) {
    return detailsBlock(
      fields.map((field) =>
        kv(
          field.label,
          field.status ? chip(field.value, statusColor(field.status)) : field.value,
          14,
        ),
      ),
    );
  }

  const isCompact = () => renderer.width < 110;
  function modalWidth() {
    return isCompact()
      ? { left: 1, width: Math.max(1, renderer.width - 2) }
      : { left: "16%" as const, width: "68%" as const };
  }
  /** Translate renderer handles to the small capabilities each mode needs. */
  function overlayHandle(overlay: BoxRenderable, focus: () => void, modal = true): Overlay {
    return {
      mount: () => renderer.root.add(overlay),
      dispose: () => {
        renderer.root.remove(overlay);
        overlay.destroyRecursively();
      },
      focus,
      resize: () => {
        if (!modal) return;
        const dimensions = modalWidth();
        overlay.left = dimensions.left;
        overlay.width = dimensions.width;
      },
    };
  }

  function scrollOverlay(scroll: ScrollBoxRenderable, key: ScrollKey): void {
    if (key === "home") scroll.scrollTo(0);
    else if (key === "end") scroll.scrollTo(scroll.scrollHeight);
    else scroll.scrollBy(key === "pageup" ? -1 : 1, "viewport");
  }

  return {
    box,
    text,
    statusColor,
    detailFields,
    isCompact,
    modalWidth,
    overlayHandle,
    scrollOverlay,
  };
}
