#!/usr/bin/env bun

// PROTOTYPE: five audit inventory projections plus a command palette.

import {
  BoxRenderable,
  fg,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  TextRenderable,
  type KeyEvent,
} from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { resolve } from "node:path";
import { Effect, FileSystem, Layer, Schema } from "effect";
import {
  SkitConfiguration,
  skitConfigurationLayer,
  LibraryActor,
  libraryApplicationLayer,
  openLibrarySession,
  readLibrarySkillContent,
  refreshLibrarySession,
  proposeLibraryEnable,
  proposeLibraryCollectionChange,
  libraryCollectionScopes,
  proposeLibraryDisable,
  proposeLibraryInvocation,
  confirmLibraryChange,
  cancelLibraryChange,
  DESTINATION_QUESTION,
  destinationLabel,
  invocationChoices,
  invocationBriefing,
  invocationEligibleScopes,
  invocationRowSummary,
  scopeChoices,
  type LibraryActionOutcome,
  type ScopeRow,
  type LibrarySkillRow,
  type Scope,
  type InvocationOption,
} from "../../cli/src/library-application/index";
import {
  errorMessage,
  auditLocalCapabilitiesV1Alpha4,
  probeHarness,
  type HarnessProbeResult,
} from "../../cli/src/front-end";
import {
  HarnessName,
  LibraryStore,
  readListingBudgets,
  type ListingBudget,
} from "@smolai/skit-core";
import { budgetDetails } from "./budget/details";
import { createLibraryHost } from "./library-host";
import { createRenderer, writeFrame } from "./snapshot";
import { createInteractionController, type Overlay, type ScrollKey } from "./interaction";
import { copySelectedText, isCopySelectionKey } from "./selection-copy";
import {
  chip,
  ink,
  keybar,
  kv,
  listColors,
  panelColors,
  panelTitle,
  detailsBlock,
  sep,
  surface,
  tone,
} from "./theme";
import { groupForSkill } from "./skill-groups";
import {
  auditPresentation,
  inventoryPresentation,
  libraryRows,
  detailPresentation,
  confirmationPresentation,
  harnessProbePresentation,
  type AuditItem,
  type InventoryItem,
  type LibraryCollectionRow,
  type SkillNavigation,
  type DetailField,
} from "./presentation";

let libraryCollectionId: string | undefined;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

// One host runtime and serialized state transitions for the writable Library view.
const libraryHost = createLibraryHost(
  libraryApplicationLayer.pipe(
    Layer.provideMerge(skitConfigurationLayer(flag("--skit-home"))),
    Layer.provideMerge(Layer.succeed(LibraryActor)("tui")),
  ),
  openLibrarySession(),
);
const paths = await libraryHost.run(SkitConfiguration);
const codexRoot = flag("--codex-root");
const claudeRoot = flag("--claude-root");
const libraryConfiguration = {
  home: paths.userHome,
  configHome: paths.configHome,
  overrides: {
    ...(codexRoot === undefined ? {} : { codex: [codexRoot] }),
    ...(claudeRoot === undefined ? {} : { "claude-code": [claudeRoot] }),
  },
  now: () => new Date().toISOString(),
};
let libraryOpenError: string | undefined;
// Every workflow the TUI runs enters the runtime through the host, the audit included.
const report = await libraryHost.run(
  auditLocalCapabilitiesV1Alpha4({
    home: flag("--home"),
    cwd: flag("--cwd") ?? resolve(import.meta.dir, "../../.."),
    probes: [],
  }),
);
let listingBudgets: readonly ListingBudget[] = [];
async function refreshListingBudgets(): Promise<void> {
  listingBudgets = await libraryHost.run(
    Effect.gen(function* () {
      const state = yield* (yield* LibraryStore).load;
      return yield* readListingBudgets(state, {
        cwd: flag("--cwd") ?? process.cwd(),
        home: libraryConfiguration.home,
        configHome: libraryConfiguration.configHome,
        overrides: libraryConfiguration.overrides,
      });
    }),
  );
}
const transitionLibrary: typeof libraryHost.transition = async (update) => {
  const outcome = await libraryHost.transition(update);
  if (outcome?.kind === "applied") await refreshListingBudgets();
  return outcome;
};
try {
  await libraryHost.open();
  await refreshListingBudgets();
} catch (error) {
  libraryOpenError = errorMessage(error);
}

const { sections, skillItems, skillGroups } = auditPresentation(report);
let skillNavigation: SkillNavigation = { view: "groups" };

const snapshotPath = process.env.SKIT_TUI_SNAPSHOT;
const { renderer, test } = await createRenderer(
  snapshotPath,
  process.env.SKIT_TUI_SNAPSHOT_SIZE,
).catch(async (error: unknown) => {
  await libraryHost.dispose();
  throw error;
});
renderer.once("destroy", () => {
  void libraryHost.dispose();
});

const requestedView = flag("--view");
const requestedVariant = sections.findIndex((section) => section.key === requestedView);
let variant = requestedVariant < 0 ? 0 : requestedVariant;
const requestedItem = flag("--item");
const requestedSkill = skillItems.find((item) => item.name === requestedItem);
if (sections[variant]?.key === "skills" && requestedSkill) {
  const group = groupForSkill(skillGroups, requestedSkill);
  if (group) skillNavigation = { view: "skills", group };
}
const requestedItemIndex =
  sections[variant]?.key === "skills" && skillNavigation.view === "groups"
    ? skillGroups.findIndex((group) => group.label === requestedItem)
    : (skillNavigation.view === "skills"
        ? skillNavigation.group.skills
        : sections[variant]?.items
      )?.findIndex((item) => item.name === requestedItem);
let selectedItem =
  requestedItemIndex !== undefined && requestedItemIndex >= 0 ? requestedItemIndex : 0;
if (sections[variant]?.key === "library" && requestedItem) {
  const rows = libraryRows(libraryHost.state?.skills ?? [], libraryCollectionId);
  const collectionIndex = rows.findIndex((row) => row.name === requestedItem);
  if (collectionIndex >= 0) selectedItem = collectionIndex;
  else {
    const skill = libraryHost.state?.skills.find((row) => row.name === requestedItem);
    if (skill) {
      libraryCollectionId = skill.collectionId;
      selectedItem = libraryRows(libraryHost.state?.skills ?? [], libraryCollectionId).findIndex(
        (row) => row.kind === "library-skill" && row.row.skillVersionId === skill.skillVersionId,
      );
    }
  }
}
let currentView: BoxRenderable | null = null;
const interaction = createInteractionController(renderInventory);
let pendingSkillPreview: Promise<void> | undefined;

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

let narrowDetails = false;
let detailsScroll: ScrollBoxRenderable | null = null;
const isNarrow = () => renderer.width < 80;
const isCompact = () => renderer.width < 110;
function modalWidth() {
  return isCompact()
    ? { left: 1, width: Math.max(1, renderer.width - 2) }
    : { left: "16%" as const, width: "68%" as const };
}
function fitLabel(value: string, width: number): string {
  const chars = Array.from(value);
  return chars.length <= width ? value : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function header(title: string, subtitle: string): BoxRenderable {
  const result = box(`header-${variant}`, {
    width: "100%",
    height: 3,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  });
  result.add(
    new TextRenderable(renderer, {
      id: `title-${variant}`,
      content: isCompact()
        ? `SKIT / ${title}`
        : new StyledText([
            fg(ink.strong)("SKIT"),
            sep(),
            fg(ink.muted)(sections[variant]?.key === "library" ? "Skills" : "Audit"),
            sep(),
            fg(tone.accent)(title),
          ]),
      marginLeft: 1,
    }),
  );
  if (!isCompact())
    result.add(text(`subtitle-${variant}`, subtitle, { fg: ink.faint, marginRight: 1 }));
  return result;
}

function footer(label: string): BoxRenderable {
  const result = box(`footer-${variant}`, {
    width: "100%",
    height: 2,
    paddingLeft: 1,
    alignItems: "center",
  });
  result.add(
    new TextRenderable(renderer, {
      id: `footer-text-${variant}`,
      content: keybar(
        isCompact()
          ? [
              ["enter", "open"],
              ["esc", "back"],
              ...(sections[variant]?.key === "library" ? [["e/d", ""] as [string, string]] : []),
              ["^P", "menu"],
            ]
          : [
              ["↑↓", "browse"],
              ...(sections[variant]!.key === "harnesses"
                ? [["p", "probe"] as [string, string], ["P", "probe all"] as [string, string]]
                : []),
              ...(sections[variant]!.key === "library"
                ? [
                    ...(libraryCollectionId === undefined
                      ? [
                          ["enter", "open collection"] as [string, string],
                          ["e", "enable"] as [string, string],
                          ["d", "disable"] as [string, string],
                        ]
                      : [
                          ["esc", "collections"] as [string, string],
                          ["e", "enable"] as [string, string],
                          ["d", "disable"] as [string, string],
                          ["i", "when used"] as [string, string],
                        ]),
                    ["r", "refresh"] as [string, string],
                  ]
                : []),
              ...(sections[variant]!.key === "skills"
                ? skillNavigation.view === "groups"
                  ? [["enter", "open"] as [string, string]]
                  : [
                      ["enter", "read"] as [string, string],
                      ["esc", "collections"] as [string, string],
                    ]
                : []),
              ["[ ]", "view"],
              ["1–6", "jump"],
              ["^P", "commands"],
              ["q", "quit"],
            ],
      ),
    }),
  );
  if (!isCompact())
    result.add(text(`footer-label-${variant}`, label, { fg: ink.faint, marginLeft: 1 }));
  return result;
}

function currentSectionPresentation() {
  return inventoryPresentation(sections[variant]!, {
    skills: libraryHost.state?.skills ?? [],
    collectionId: libraryCollectionId,
    skillGroups,
    skillNavigation,
    findings: report.summary.findings,
    libraryError: libraryOpenError,
  });
}

function currentSectionItems(): InventoryItem[] {
  return currentSectionPresentation().items;
}

function selectedLibraryRow(): LibrarySkillRow | undefined {
  if (sections[variant]?.key !== "library") return;
  const item = currentSectionItems()[selectedItem];
  return item?.kind === "library-skill" ? item.row : undefined;
}

function inventoryView(): BoxRenderable {
  detailsScroll = null;
  const section = sections[variant]!;
  const model = currentSectionPresentation();
  const sectionItems = model.items;
  selectedItem = Math.min(selectedItem, Math.max(0, sectionItems.length - 1));
  const root = box("inventory-root", {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: surface.canvas,
  });
  root.add(header(section.title, model.subtitle));

  if (section.key === "library" && showNoChangeNotice)
    root.add(
      text("library-no-change", "Already set this way. Nothing to change.", {
        height: 1,
        paddingLeft: 1,
        fg: ink.faint,
      }),
    );
  const body = box("inventory-body", {
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    padding: 1,
    backgroundColor: "transparent",
  });
  const listWidth = isNarrow()
    ? Math.max(1, renderer.width - 2)
    : isCompact()
      ? 30
      : Math.min(52, Math.floor(renderer.width * 0.35));
  const listPanel = box("inventory-list-panel", {
    width: listWidth,
    minWidth: listWidth,
    maxWidth: listWidth,
    flexShrink: 0,
    height: "100%",
    border: true,
    ...panelColors(true),
    title: panelTitle(
      fitLabel(model.listTitle, listWidth - 4),
      section.key === "library" && libraryCollectionId !== undefined,
    ),
  });
  const select = new SelectRenderable(renderer, {
    id: "inventory-select",
    width: "100%",
    height: "100%",
    selectedIndex: selectedItem,
    showDescription: model.showDescription,
    itemSpacing: 0,
    options: model.options.map((option) => ({
      ...option,
      name: fitLabel(option.name, listWidth - 6),
    })),
    textColor: ink.DEFAULT,
    descriptionColor: ink.faint,
    ...listColors(true),
    focusedBackgroundColor: "transparent",
    focusedTextColor: ink.DEFAULT,
    wrapSelection: true,
  });
  select.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
    if (selectedItem !== index) interaction.navigationChanged();
    selectedItem = index;
    const item = sectionItems[index];
    if (detailsScroll && item) populateDetails(detailsScroll, item);
    else if (!isNarrow() || narrowDetails) render();
  });
  select.on(SelectRenderableEvents.ITEM_SELECTED, () => openSelectedSkill());
  listPanel.add(select);
  if (!(isNarrow() && narrowDetails)) select.focus();

  const item = sectionItems[selectedItem];
  if (item && isNarrow() && !narrowDetails) {
    body.add(listPanel);
    root.add(body);
    root.add(footer(section.title));
    return root;
  }
  if (!item) {
    const empty = box("inventory-empty", {
      flexGrow: 1,
      minWidth: 0,
      height: "100%",
      border: true,
      ...panelColors(false),
      title: panelTitle("details"),
      padding: 2,
    });
    empty.add(
      text("inventory-empty-text", model.emptyMessage, {
        fg: ink.faint,
      }),
    );
    if (!isNarrow()) body.add(listPanel);
    body.add(empty);
    root.add(body);
    root.add(footer(`${variant + 1} / ${section.title.toLowerCase()}`));
    return root;
  }
  const details = new ScrollBoxRenderable(renderer, {
    id: "inventory-details",
    scrollY: true,
    scrollX: false,
    verticalScrollbarOptions: { visible: true },
    horizontalScrollbarOptions: { visible: false },
    contentOptions: { flexDirection: "column", gap: 1, flexShrink: 0 },
    flexGrow: 1,
    minWidth: 0,
    height: "100%",
    border: true,
    ...panelColors(false),
    title:
      item.kind === "library-collection" || item.kind === "library-skill"
        ? ` ${item.name} `
        : panelTitle(section.key === "library" ? "details" : "evidence"),
    titleColor: section.key === "library" ? tone.accent : ink.faint,
    padding: isCompact() ? 1 : 2,
  });
  detailsScroll = details;
  if (isNarrow()) details.focus();
  populateDetails(details, item);

  if (!isNarrow()) body.add(listPanel);
  body.add(details);
  root.add(body);
  root.add(footer(`${variant + 1} / ${section.title.toLowerCase()}`));
  return root;
}

let detailRevision = 0;
function populateDetails(details: ScrollBoxRenderable, item: InventoryItem): void {
  const section = sections[variant]!;
  const revision = ++detailRevision;
  details.title =
    item.kind === "library-collection" || item.kind === "library-skill"
      ? ` ${item.name} `
      : panelTitle(section.key === "library" ? "details" : "evidence");
  for (const child of details.content.getChildren()) {
    details.remove(child);
    child.destroyRecursively();
  }
  details.scrollTo(0);
  if (item.kind === "library-skill") {
    if (item.row.invocationWarning)
      details.add(
        text("library-invocation-unavailable", item.row.invocationWarning, {
          width: "100%",
          fg: tone.warning,
        }),
      );
    const content = text("library-skill-content", "Loading…", { width: "100%" });
    details.add(content);
    pendingSkillPreview = libraryHost.run(readLibrarySkillContent(item.row.skillVersionId)).then(
      (value) => {
        if (detailsScroll === details && revision === detailRevision) content.content = value;
      },
      (error: unknown) => {
        if (detailsScroll === details && revision === detailRevision)
          content.content = `Unable to read retained Skill\n${errorMessage(error)}`;
      },
    );
    return;
  }
  const model = detailPresentation(item, section.key === "library", listingBudgets);
  if (model.source !== undefined) {
    details.add(text("collection-source-title", "Source", { fg: tone.accentSoft }));
    details.add(text("collection-source", model.source));
  } else {
    details.add(text("detail-name", item.name, { fg: statusColor(item.status) }));
    details.add(
      new TextRenderable(renderer, { id: "detail-fields", content: detailFields(model.fields) }),
    );
  }
  details.add(text("detail-summary", item.summary));
  if (model.budget) {
    details.add(
      text("harness-listing-budget-title", "Skill listing budget", { fg: tone.accentSoft }),
    );
    details.add(
      new TextRenderable(renderer, {
        id: "harness-listing-budget",
        content: budgetDetails(model.budget),
      }),
    );
  }
  const addEvidence = () => {
    details.add(text("detail-evidence-title", model.evidenceTitle, { fg: tone.accentSoft }));
    details.add(text("detail-evidence", model.evidence));
  };
  if (!model.evidenceLast) addEvidence();
  details.add(text("detail-action-title", "Actions", { fg: tone.accentSoft }));
  if (model.shortcuts.length) {
    const actions = box("detail-actions", { flexDirection: "column", gap: 0, flexShrink: 0 });
    for (const [index, shortcut] of model.shortcuts.entries()) {
      actions.add(
        new TextRenderable(renderer, { id: `detail-action-${index}`, content: keybar([shortcut]) }),
      );
    }
    details.add(actions);
  } else {
    details.add(text("detail-action", model.action));
  }
  if (model.evidenceLast) addEvidence();
}

function render(): void {
  interaction.renderBrowse();
}

function renderNavigation(): void {
  interaction.navigationChanged();
  render();
}

function renderInventory(): void {
  if (currentView) {
    renderer.root.remove(currentView);
    currentView.destroyRecursively();
  }
  currentView = inventoryView();
  renderer.root.add(currentView);
}

function switchVariant(next: number): void {
  showNoChangeNotice = false;
  variant = (next + sections.length) % sections.length;
  skillNavigation = { view: "groups" };
  libraryCollectionId = undefined;
  narrowDetails = false;
  selectedItem = 0;
  renderNavigation();
}

const keymap = createDefaultOpenTuiKeymap(renderer);
const viewCommandNames = [
  "view.library",
  "view.harnesses",
  "view.skills",
  "view.claude-plugins",
  "view.codex-plugins",
  "view.mcps",
] as const;

const paletteCommands = [
  {
    name: "view.harnesses",
    title: "Open Harnesses",
    description: "Browse agent harnesses detected on this system",
    shortcut: "2",
    keywords: "agents adapters detected",
    run: () => switchVariant(1),
  },
  {
    name: "view.skills",
    title: "Open Skills",
    description: "Browse all discovered Skills",
    shortcut: "3",
    keywords: "instructions capabilities audit",
    run: () => switchVariant(2),
  },
  {
    name: "view.claude-plugins",
    title: "Open Claude plugins",
    description: "Browse plugins installed for Claude Code",
    shortcut: "4",
    keywords: "claude code extensions",
    run: () => switchVariant(3),
  },
  {
    name: "view.codex-plugins",
    title: "Open Codex plugins",
    description: "Browse plugins installed for Codex",
    shortcut: "5",
    keywords: "codex extensions",
    run: () => switchVariant(4),
  },
  {
    name: "view.mcps",
    title: "Open MCPs",
    description: "Browse MCP registrations across all harnesses",
    shortcut: "6",
    keywords: "mcp server transport tools",
    run: () => switchVariant(5),
  },
  {
    name: "view.library",
    title: "Open Library",
    description: "Enable, disable, and choose when agents may use Library skills",
    shortcut: "1",
    keywords: "library enable disable invocation binding installed skill",
    run: () => switchVariant(0),
  },
  {
    name: "app.quit",
    title: "Quit SKIT audit",
    description: "Close the interactive audit",
    shortcut: "Q",
    keywords: "exit close",
    run: async () => {
      await libraryHost.dispose();
      renderer.destroy();
    },
  },
] as const;

keymap.registerLayer({ commands: paletteCommands });

function commandField(
  command: (typeof paletteCommands)[number],
  field: "title" | "description" | "shortcut",
): string {
  return command[field];
}

function closePalette(): void {
  interaction.close("palette");
}

function runPaletteCommand(name: string): void {
  closePalette();
  keymap.runCommand(name);
}

function openSelectedSkill(): void {
  if (
    interaction.kind !== "browse" ||
    (!isNarrow() && !(sections[variant]?.key === "library" || sections[variant]?.key === "skills"))
  )
    return;
  const item = currentSectionItems()[selectedItem];
  if (item?.kind === "library-collection") {
    libraryCollectionId = item.collectionId;
    narrowDetails = false;
    selectedItem = 0;
    renderNavigation();
    return;
  }
  if (item?.kind === "skill-group") {
    skillNavigation = { view: "skills", group: item.group };
    selectedItem = 0;
    renderNavigation();
    return;
  }
  if (item && isNarrow() && !narrowDetails) {
    narrowDetails = true;
    renderNavigation();
    return;
  }
  if (!item || item.kind !== "skill") return;
  const location = item.location;
  const name = item.name;
  const stillBrowsing = interaction.captureBrowse();
  void libraryHost
    .run(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(location)).pipe(
        Effect.catch((error) => Effect.succeed(`Unable to read ${location}\n\n${error.message}`)),
      ),
    )
    .then((content) => {
      const selected = currentSectionItems()[selectedItem];
      if (!stillBrowsing() || selected?.kind !== "skill" || selected.location !== location) return;
      showDocument(name, location, content);
    });
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
    title: panelTitle(`SKILL.md · ${name}`),
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

/** Harnesses with a probe already running, so a repeated key cannot start a second one. */
const probing = new Set<string>();

async function runHarnessProbe(item: AuditItem): Promise<void> {
  if (item.kind !== "harness" || !Schema.is(HarnessName)(item.name)) return;
  if (probing.has(item.name)) return;
  probing.add(item.name);
  let result: HarnessProbeResult;
  try {
    result = await libraryHost.run(probeHarness(item.name));
  } catch (error) {
    item.status = "error";
    item.summary = `Harness probe failed: ${errorMessage(error)}`;
    return;
  } finally {
    probing.delete(item.name);
  }
  Object.assign(item, harnessProbePresentation(item, result));
}

function probeSelectedHarness(all: boolean): void {
  if (sections[variant]?.key !== "harnesses") return;
  const targets = all
    ? sections[variant].items
    : sections[variant].items.slice(selectedItem, selectedItem + 1);
  // Probing is asynchronous now; render when it finishes rather than blocking the key handler.
  void (async () => {
    for (const item of targets) await runHarnessProbe(item);
    render();
  })();
}

const ALL_SCOPES = "all";

interface ChooserOption {
  value: string;
  label: string;
  hint?: string;
}

interface Chooser {
  title: string;
  /** What the operator needs to know before deciding, shown above the options. */
  briefing?: string;
  options: readonly ChooserOption[];
  choose: (value: string) => void | Promise<void>;
}

let showNoChangeNotice = false;

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
  select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value?: unknown }) => {
    if (typeof option?.value !== "string") return;
    const value = option.value;
    closeChooser();
    void chooser.choose(value);
  });
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
function openConfirm(): void {
  const pending = libraryHost.state?.pending;
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

function afterProposal(outcome: LibraryActionOutcome | undefined): void {
  if (!outcome) return;
  showNoChangeNotice = outcome.kind === "unchanged";
  render();
  if (outcome.kind === "preview") {
    openConfirm();
  }
}

function chooseScopeThen(next: (scope: Scope) => void | Promise<void>): void {
  const choices = scopeChoices(resolve(process.cwd()));
  if (choices.length === 1) {
    void next(choices[0]!.scope);
    return;
  }
  openChooser({
    title: DESTINATION_QUESTION,
    options: choices.map((choice) => ({
      value: choice.value,
      label: choice.label,
      ...(choice.hint ? { hint: choice.hint } : {}),
    })),
    choose: (value) => next(choices.find((choice) => choice.value === value)!.scope),
  });
}

function scopeChooserOptions(scopes: readonly ScopeRow[]): ChooserOption[] {
  return scopes.map((scopeRow, index) => ({
    value: String(index),
    label: destinationLabel(scopeRow.scope),
    ...(scopeRow.policy ? { hint: invocationRowSummary(scopeRow.policy) } : {}),
  }));
}

function selectedLibraryCollection(): LibraryCollectionRow | undefined {
  if (sections[variant]?.key !== "library") return;
  const item = currentSectionItems()[selectedItem];
  return item?.kind === "library-collection" ? item : undefined;
}

function startEnable(): void {
  const collection = selectedLibraryCollection();
  if (collection && libraryHost.state) {
    chooseScopeThen(async (scope) =>
      afterProposal(
        await transitionLibrary((state) =>
          proposeLibraryCollectionChange(
            state,
            libraryConfiguration,
            collection.collectionId,
            true,
            [scope],
          ),
        ),
      ),
    );
    return;
  }
  const row = selectedLibraryRow();
  if (!row || !libraryHost.state) return;
  openChooser({
    title: "What would you like to enable?",
    options: [
      ...(row.hasCollection === false
        ? []
        : [
            {
              value: "collection",
              label: `Enable whole collection · ${row.heading}`,
              hint: "Include new skills and remove deleted ones when you update",
            },
          ]),
      { value: "skill", label: `Enable ${row.name}`, hint: "Only this Skill" },
    ],
    choose: (value) =>
      chooseScopeThen(async (scope) =>
        afterProposal(
          await transitionLibrary((state) =>
            value === "collection"
              ? proposeLibraryCollectionChange(
                  state,
                  libraryConfiguration,
                  row.collectionId,
                  true,
                  [scope],
                )
              : proposeLibraryEnable(state, libraryConfiguration, row, { scope }),
          ),
        ),
      ),
  });
}

function disableCollection(collectionId: string): void {
  if (!libraryHost.state) return;
  const scopes = libraryCollectionScopes(libraryHost.state, collectionId);
  if (!scopes.length) return;
  const disable = async (selectedScopes: readonly Scope[]) =>
    afterProposal(
      await transitionLibrary((state) =>
        proposeLibraryCollectionChange(
          state,
          libraryConfiguration,
          collectionId,
          false,
          selectedScopes,
        ),
      ),
    );
  if (scopes.length === 1) void disable(scopes);
  else
    openChooser({
      title: DESTINATION_QUESTION,
      options: [
        { value: ALL_SCOPES, label: "All shown" },
        ...scopes.map((scope, index) => ({
          value: String(index),
          label: destinationLabel(scope),
        })),
      ],
      choose: (value) => disable(value === ALL_SCOPES ? scopes : [scopes[Number(value)]!]),
    });
}

function startDisable(): void {
  const collection = selectedLibraryCollection();
  if (collection) {
    disableCollection(collection.collectionId);
    return;
  }
  const row = selectedLibraryRow();
  if (!row || !libraryHost.state) return;
  const scopes = libraryCollectionScopes(libraryHost.state, row.collectionId);
  if (!scopes.length) return;
  openChooser({
    title: "What would you like to disable?",
    options: [
      ...(row.hasCollection === false
        ? []
        : [
            {
              value: "collection",
              label: `Disable whole collection · ${row.heading}`,
              hint: "Disable every skill in this collection",
            },
          ]),
      ...(row.scopes.length ? [{ value: "skill", label: `Disable ${row.name}` }] : []),
    ],
    choose: (value) => {
      if (value === "collection") {
        disableCollection(row.collectionId);
        return;
      }
      const disable = async (scopes: readonly ScopeRow[]) =>
        afterProposal(
          await transitionLibrary((state) =>
            proposeLibraryDisable(state, libraryConfiguration, row, scopes),
          ),
        );
      if (row.scopes.length === 1) void disable(row.scopes);
      else
        openChooser({
          title: DESTINATION_QUESTION,
          options: [{ value: ALL_SCOPES, label: "All shown" }, ...scopeChooserOptions(row.scopes)],
          choose: (chosen) =>
            disable(chosen === ALL_SCOPES ? row.scopes : [row.scopes[Number(chosen)]!]),
        });
    },
  });
}

function startInvocation(): void {
  const row = selectedLibraryRow();
  const session = libraryHost.state;
  if (!row || !session) return;
  const eligible = invocationEligibleScopes(row);
  if (!eligible.length) return;
  const choosePolicy = (scopeRow: ScopeRow) => {
    if (!scopeRow.policy) return;
    openChooser({
      title: scopeRow.policy.question,
      briefing: invocationBriefing(scopeRow.policy),
      options: invocationChoices(scopeRow).map((choice) => ({
        value: choice.value,
        label: choice.label,
        ...(choice.hint ? { hint: choice.hint } : {}),
      })),
      choose: async (value) =>
        afterProposal(
          await transitionLibrary((state) =>
            proposeLibraryInvocation(
              state,
              libraryConfiguration,
              row,
              scopeRow,
              value as InvocationOption,
            ),
          ),
        ),
    });
  };
  if (eligible.length === 1) choosePolicy(eligible[0]!);
  else
    openChooser({
      title: DESTINATION_QUESTION,
      options: scopeChooserOptions(eligible),
      choose: (value) => choosePolicy(eligible[Number(value)]!),
    });
}

async function applyPending(): Promise<void> {
  closeConfirm();
  if (!libraryHost.state) return;
  await transitionLibrary((state) => confirmLibraryChange(state));
  render();
}

async function cancelPending(): Promise<void> {
  closeConfirm();
  if (libraryHost.state)
    await transitionLibrary((state) => Effect.succeed(cancelLibraryChange(state)));
  render();
}

async function refreshLibrary(): Promise<void> {
  if (!libraryHost.state) return;
  await transitionLibrary((state) => refreshLibrarySession(state));
  await refreshListingBudgets();
  render();
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
    }) as (typeof paletteCommands)[number][];
    select.options = commands.map((command) => ({
      name: commandField(command, "title"),
      description: `${commandField(command, "description")}${command.shortcut ? `  ·  ${command.shortcut}` : ""}`,
      value: command.name,
    }));
    select.setSelectedIndex(0);
  };

  input.on(InputRenderableEvents.INPUT, (value: string) => updateResults(value));
  input.on(InputRenderableEvents.ENTER, () => select.selectCurrent());
  select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value?: unknown }) => {
    if (typeof option?.value === "string") runPaletteCommand(option.value);
  });
  updateResults("");
  overlay.add(input);
  overlay.add(select);
  overlay.add(text("command-palette-help", "↑↓ browse   enter run   esc close", { fg: ink.faint }));
  interaction.open({
    kind: "palette",
    view: {
      ...overlayHandle(overlay, () => input.focus()),
      move: (direction) => (direction === "up" ? select.moveUp() : select.moveDown()),
    },
  });
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

function handleGlobalKey(key: KeyEvent): void {
  const result = interaction.handleKey(key, {
    section: sections[variant]!.key,
    variant,
    viewCount: sections.length,
    narrow: isNarrow(),
    narrowDetails,
    hasDetails: detailsScroll !== null,
    insideSkillGroup: skillNavigation.view === "skills",
    insideCollection: libraryCollectionId !== undefined,
    copySelection: isCopySelectionKey(key, renderer.hasSelection),
  });
  if (result.preventDefault) key.preventDefault();
  if (result.stopPropagation) key.stopPropagation();
  const command = result.command;
  if (!command) return;
  switch (command.kind) {
    case "quit":
      keymap.runCommand("app.quit", { event: key });
      break;
    case "copy":
      copySelectedText(renderer);
      break;
    case "apply":
      void applyPending();
      break;
    case "cancel":
      void cancelPending();
      break;
    case "open-palette":
      openPalette();
      break;
    case "open-selected":
      openSelectedSkill();
      break;
    case "back-details":
      narrowDetails = false;
      renderNavigation();
      break;
    case "back-skills":
      skillNavigation = { view: "groups" };
      selectedItem = 0;
      renderNavigation();
      break;
    case "back-collection": {
      const previous = libraryCollectionId;
      libraryCollectionId = undefined;
      selectedItem = libraryRows(libraryHost.state?.skills ?? []).findIndex(
        (row) => row.kind === "library-collection" && row.collectionId === previous,
      );
      renderNavigation();
      break;
    }
    case "scroll-details":
      if (detailsScroll) scrollOverlay(detailsScroll, command.key);
      break;
    case "probe":
      probeSelectedHarness(command.all);
      break;
    case "enable":
      startEnable();
      break;
    case "disable":
      startDisable();
      break;
    case "invocation":
      startInvocation();
      break;
    case "refresh":
      void refreshLibrary();
      break;
    case "switch-view":
      keymap.runCommand(viewCommandNames[command.index]!, { event: key });
      break;
  }
}

renderer.keyInput.on("keypress", handleGlobalKey);
renderer.on("resize", () => {
  const scrollTop = detailsScroll?.scrollTop;
  interaction.resize();
  if (scrollTop !== undefined) detailsScroll?.scrollTo(scrollTop);
});

if (process.env.SKIT_TUI_SNAPSHOT_DETAILS === "1") narrowDetails = true;
render();

if (process.env.SKIT_TUI_SNAPSHOT_HARNESS_PROBE === "1") probeSelectedHarness(true);
if (process.env.SKIT_TUI_SNAPSHOT_PALETTE === "1") openPalette();
if (process.env.SKIT_TUI_SNAPSHOT_DOCUMENT === "1") {
  if (sections[variant]?.key === "skills" && skillNavigation.view === "groups") {
    skillNavigation = { view: "skills", group: skillGroups[0]! };
    selectedItem = 0;
    render();
  }
  openSelectedSkill();
}

if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY && sections[variant]?.key === "library") {
  if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY === "enable") startEnable();
  if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY === "disable") startDisable();
  if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY === "confirm") {
    const collection = selectedLibraryCollection();
    if (collection && libraryHost.state)
      afterProposal(
        await transitionLibrary((state) =>
          proposeLibraryCollectionChange(
            state,
            libraryConfiguration,
            collection.collectionId,
            true,
            [{ kind: "global" }],
          ),
        ),
      );
    const row = selectedLibraryRow();
    if (row && libraryHost.state)
      afterProposal(
        await transitionLibrary((state) =>
          proposeLibraryEnable(state, libraryConfiguration, row, { scope: { kind: "global" } }),
        ),
      );
  }
}

if (test && snapshotPath) {
  await test.flush();
  if (process.env.SKIT_TUI_SNAPSHOT_KEYS) {
    // Each step waits for the work it started; `a+b` presses keys back-to-back before it can finish.
    for (const step of process.env.SKIT_TUI_SNAPSHOT_KEYS.split(",")) {
      const leavingDetails = step === "ESCAPE" && isNarrow() && narrowDetails;
      for (const key of step.split("+")) test.mockInput.pressKey(key);
      if (leavingDetails) await test.waitFor(() => !narrowDetails);
      await libraryHost.settled();
      await test.flush();
    }
  }
  if (process.env.SKIT_TUI_SNAPSHOT_RESIZE) {
    const [width, height] = process.env.SKIT_TUI_SNAPSHOT_RESIZE.split("x").map(Number);
    if (width && height) test.resize(width, height);
  }
  await pendingSkillPreview;
  await writeFrame(test, snapshotPath);
  await libraryHost.dispose();
  renderer.destroy();
}
