/** Rendered overlays expose only the operations their interaction mode supports. */
export interface Overlay {
  mount(): void;
  dispose(): void;
  focus(): void;
  resize(): void;
}
export type ScrollKey = "home" | "end" | "pageup" | "pagedown";
interface ScrollOverlay extends Overlay {
  scroll(key: ScrollKey): void;
}
interface SelectOverlay extends Overlay {
  move(direction: "up" | "down"): void;
}
interface ConfirmationOverlay extends ScrollOverlay {
  update(showSkills: boolean): void;
}

type OpenMode =
  | { kind: "document"; view: ScrollOverlay }
  | { kind: "chooser" | "palette"; view: SelectOverlay }
  | { kind: "confirm"; view: ConfirmationOverlay; canShowSkills: boolean };
type Mode =
  | { kind: "browse" }
  | Exclude<OpenMode, { kind: "confirm" }>
  | (Extract<OpenMode, { kind: "confirm" }> & { showSkills: boolean });

export interface InteractionKey {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}
export interface BrowseContext {
  readonly section: string;
  readonly variant: number;
  readonly viewCount: number;
  readonly narrow: boolean;
  readonly narrowDetails: boolean;
  readonly hasDetails: boolean;
  readonly insideSkillGroup: boolean;
  readonly insideCollection: boolean;
  readonly copySelection: boolean;
}
export type InteractionCommand =
  | {
      kind:
        | "quit"
        | "copy"
        | "apply"
        | "cancel"
        | "back-details"
        | "open-selected"
        | "back-skills"
        | "back-collection"
        | "open-palette"
        | "enable"
        | "disable"
        | "invocation"
        | "refresh";
    }
  | { kind: "probe"; all: boolean }
  | { kind: "switch-view"; index: number }
  | { kind: "scroll-details"; key: ScrollKey };
export interface KeyResult {
  readonly preventDefault?: boolean;
  readonly stopPropagation?: boolean;
  readonly command?: InteractionCommand;
}
const scrollKey = (name: string): name is ScrollKey =>
  ["home", "end", "pageup", "pagedown"].includes(name);
const command = (value: InteractionCommand, stopPropagation = false): KeyResult => ({
  command: value,
  preventDefault: true,
  stopPropagation,
});

/** Owns modal exclusivity, disposal, focus restoration and key routing. No Library writes or renderer imports. */
export function createInteractionController(renderInventory: () => void) {
  let mode: Mode = { kind: "browse" };
  let revision = 0;
  const renderBrowse = () => {
    renderInventory();
    if (mode.kind !== "browse") mode.view.focus();
  };
  const close = (kind: OpenMode["kind"]) => {
    if (mode.kind !== kind) return;
    const prior = mode;
    mode = { kind: "browse" };
    revision++;
    prior.view.dispose();
    renderBrowse();
  };
  const open = (next: OpenMode) => {
    if (mode.kind !== "browse") mode.view.dispose();
    revision++;
    mode = next.kind === "confirm" ? { ...next, showSkills: false } : next;
    next.view.mount();
    next.view.focus();
  };
  const handleKey = (key: InteractionKey, context: BrowseContext): KeyResult => {
    if (key.ctrl && key.name === "c") return command({ kind: "quit" });
    if (context.copySelection) return command({ kind: "copy" });
    switch (mode.kind) {
      case "document":
        if (key.name === "escape") {
          close("document");
          return { preventDefault: true, stopPropagation: true };
        }
        if (key.name === "home" || key.name === "end") {
          mode.view.scroll(key.name);
          return { preventDefault: true };
        }
        return {};
      case "confirm":
        if (key.name === "escape") return command({ kind: "cancel" }, true);
        if (key.name === "return" || key.name === "enter") return command({ kind: "apply" }, true);
        if (key.name === "s" && mode.canShowSkills) {
          mode.showSkills = !mode.showSkills;
          mode.view.update(mode.showSkills);
          return { preventDefault: true, stopPropagation: true };
        }
        if (scrollKey(key.name)) {
          mode.view.scroll(key.name);
          return { preventDefault: true };
        }
        return {};
      case "chooser":
      case "palette":
        if (key.name === "escape") {
          const cancel = mode.kind === "chooser";
          close(mode.kind);
          return {
            preventDefault: true,
            stopPropagation: true,
            ...(cancel ? { command: { kind: "cancel" as const } } : {}),
          };
        }
        if (key.name === "up" || key.name === "down") {
          mode.view.move(key.name);
          return { preventDefault: true, stopPropagation: true };
        }
        return {};
      case "browse":
        if (context.narrow && context.narrowDetails && key.name === "escape")
          return command({ kind: "back-details" }, true);
        if (context.hasDetails && scrollKey(key.name))
          return command({ kind: "scroll-details", key: key.name });
        if (context.narrow && context.narrowDetails && ["return", "enter"].includes(key.name))
          return command({ kind: "open-selected" });
        if (key.name === "escape" && context.section === "skills" && context.insideSkillGroup)
          return command({ kind: "back-skills" });
        if (key.name === "escape" && context.section === "library" && context.insideCollection)
          return command({ kind: "back-collection" });
        if (key.ctrl && key.name === "p") return command({ kind: "open-palette" }, true);
        if (key.name === "q") return command({ kind: "quit" });
        if (key.name === "p" && context.section === "harnesses")
          return command({ kind: "probe", all: key.shift ?? false });
        if (context.section === "library") {
          const action = { e: "enable", d: "disable", i: "invocation", r: "refresh" } as const;
          if (key.name === "e" || key.name === "d" || key.name === "i" || key.name === "r")
            return command({ kind: action[key.name] }, true);
        }
        if (["1", "2", "3", "4", "5", "6"].includes(key.name))
          return { command: { kind: "switch-view", index: Number(key.name) - 1 } };
        if (key.name === "]" || key.name === "right")
          return {
            command: { kind: "switch-view", index: (context.variant + 1) % context.viewCount },
          };
        if (key.name === "[" || key.name === "left")
          return {
            command: {
              kind: "switch-view",
              index: (context.variant - 1 + context.viewCount) % context.viewCount,
            },
          };
        return {};
    }
  };
  return {
    get kind() {
      return mode.kind;
    },
    open,
    close,
    handleKey,
    renderBrowse,
    navigationChanged() {
      revision++;
    },
    /** Late content reads cannot reopen a document after navigation or a modal transition. */
    captureBrowse() {
      const captured = revision;
      return () => mode.kind === "browse" && revision === captured;
    },
    resize() {
      renderInventory();
      if (mode.kind !== "browse") {
        mode.view.resize();
        mode.view.focus();
      }
    },
  };
}
