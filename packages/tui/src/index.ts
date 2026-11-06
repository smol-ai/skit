#!/usr/bin/env bun
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import { probeHarness, type HarnessProbeResult } from "@smolai/skit-core/harnesses";

// PROTOTYPE: five audit inventory projections plus a command palette.

import {
  BoxRenderable,
  fg,
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
import { openLibrarySession, readLibrarySkillContent } from "@smolai/skit-core/library/session";
import { createLibraryController } from "./library/controller";
import { errorMessage } from "@smolai/skit-core/shared";
import { HarnessName, readListingBudgets, type ListingBudget } from "@smolai/skit-core/harnesses";
import * as Library from "@smolai/skit-core/library";
import { inventoryRootOptions } from "@smolai/skit-core/library/routing";
import { readInventory } from "@smolai/skit-core/library/inventory";
import { SkitConfiguration, skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import { auditLocalCapabilitiesV1Alpha4 } from "@smolai/skit-core/audit";

import { budgetDetails } from "./harness/budget-details";
import { createLibraryHost } from "./library/host";
import { createRenderer, writeFrame } from "./shell/render";
import { createInteractionController } from "./shell/interaction";
import { createViewPrimitives } from "./shell/view";
import { createLibraryOverlays } from "./library/overlays";
import { createShellOverlays } from "./shell/overlays";
import { copySelectedText, isCopySelectionKey } from "./shell/selection-copy";
import {
  ink,
  keybar,
  listColors,
  panelColors,
  panelTitle,
  sep,
  surface,
  tone,
} from "./shell/theme";
import { groupForSkill } from "./audit/skill-groups";
import {
  auditPresentation,
  inventoryPresentation,
  detailPresentation,
  harnessProbePresentation,
  type AuditItem,
  type InventoryItem,
  type SkillNavigation,
} from "./shell/presentation";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

// One host runtime and serialized state transitions for the writable Library view.
const libraryHost = createLibraryHost(
  Layer.unwrap(
    Effect.map(SkitConfiguration, (paths) =>
      Library.layer({ home: paths.skitHome, roots: inventoryRootOptions(paths) }),
    ),
  ).pipe(
    Layer.provideMerge(skitLayer),
    Layer.provideMerge(skitConfigurationLayer(flag("--skit-home"))),
  ),
  Effect.flatMap(SkitConfiguration, (paths) =>
    openLibrarySession(paths.skitHome, libraryConfiguration),
  ),
);
const paths = await libraryHost.run(SkitConfiguration);
const codexRoot = flag("--codex-root");
const claudeRoot = flag("--claude-root");
const libraryConfiguration: InventoryRootOptions = {
  home: paths.userHome,
  configHome: paths.configHome,
  overrides: {
    ...(codexRoot === undefined ? {} : { codex: [codexRoot] }),
    ...(claudeRoot === undefined ? {} : { "claude-code": [claudeRoot] }),
  },
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
      return yield* readListingBudgets(yield* readInventory, {
        cwd: flag("--cwd") ?? process.cwd(),
        home: libraryConfiguration.home,
        configHome: libraryConfiguration.configHome,
        overrides: libraryConfiguration.overrides,
      });
    }),
  );
}
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
let auditSelectedIndex =
  requestedItemIndex !== undefined && requestedItemIndex >= 0 ? requestedItemIndex : 0;
const interaction = createInteractionController(renderInventory);
const view = createViewPrimitives(renderer);
const { box, text, statusColor, detailFields, isCompact, scrollOverlay } = view;
const libraryOverlays = createLibraryOverlays(renderer, interaction, view);
const libraryController = createLibraryController({
  host: libraryHost,
  home: paths.skitHome,
  configuration: libraryConfiguration,
  active: () => sections[variant]?.key === "library",
  openChooser: libraryOverlays.openChooser,
  openConfirm: libraryOverlays.openConfirm,
  closeConfirm: libraryOverlays.closeConfirm,
  render,
  refreshListingBudgets,
});
const selection = {
  get index() {
    return sections[variant]?.key === "library"
      ? libraryController.selectedIndex
      : auditSelectedIndex;
  },
  set index(index: number) {
    if (sections[variant]?.key === "library") libraryController.selectedIndex = index;
    else auditSelectedIndex = index;
  },
};
if (sections[variant]?.key === "library" && requestedItem)
  libraryController.selectRequestedItem(requestedItem);
let currentView: BoxRenderable | null = null;
let pendingSkillPreview: Promise<void> | undefined;

let narrowDetails = false;
let detailsScroll: ScrollBoxRenderable | null = null;
const isNarrow = () => renderer.width < 80;
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
                    ...(libraryController.collectionId === undefined
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
    skills: libraryController.skills,
    collectionId: libraryController.collectionId,
    skillGroups,
    skillNavigation,
    findings: report.summary.findings,
    libraryError: libraryOpenError,
  });
}

function currentSectionItems(): InventoryItem[] {
  return currentSectionPresentation().items;
}

function inventoryView(): BoxRenderable {
  detailsScroll = null;
  const section = sections[variant]!;
  const model = currentSectionPresentation();
  const sectionItems = model.items;
  selection.index = Math.min(selection.index, Math.max(0, sectionItems.length - 1));
  const root = box("inventory-root", {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: surface.canvas,
  });
  root.add(header(section.title, model.subtitle));

  if (section.key === "library" && libraryController.showNoChangeNotice)
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
      section.key === "library" && libraryController.collectionId !== undefined,
    ),
  });
  const select = new SelectRenderable(renderer, {
    id: "inventory-select",
    width: "100%",
    height: "100%",
    selectedIndex: selection.index,
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
    if (selection.index !== index) interaction.navigationChanged();
    selection.index = index;
    const item = sectionItems[index];
    if (detailsScroll && item) populateDetails(detailsScroll, item);
    else if (!isNarrow() || narrowDetails) render();
  });
  select.on(SelectRenderableEvents.ITEM_SELECTED, () => openSelectedSkill());
  listPanel.add(select);
  if (!(isNarrow() && narrowDetails)) select.focus();

  const item = sectionItems[selection.index];
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
    pendingSkillPreview = libraryHost
      .run(readLibrarySkillContent(paths.skitHome, item.row.skillVersionId))
      .then(
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
  libraryController.reset();
  variant = (next + sections.length) % sections.length;
  skillNavigation = { view: "groups" };
  narrowDetails = false;
  selection.index = 0;
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
const shellOverlays = createShellOverlays(renderer, interaction, view, keymap);

function openSelectedSkill(): void {
  if (
    interaction.kind !== "browse" ||
    (!isNarrow() && !(sections[variant]?.key === "library" || sections[variant]?.key === "skills"))
  )
    return;
  const item = currentSectionItems()[selection.index];
  if (item?.kind === "library-collection") {
    libraryController.openCollection(item.collectionId);
    narrowDetails = false;
    selection.index = 0;
    renderNavigation();
    return;
  }
  if (item?.kind === "skill-group") {
    skillNavigation = { view: "skills", group: item.group };
    selection.index = 0;
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
      const selected = currentSectionItems()[selection.index];
      if (!stillBrowsing() || selected?.kind !== "skill" || selected.location !== location) return;
      shellOverlays.showDocument(name, location, content);
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
    : sections[variant].items.slice(selection.index, selection.index + 1);
  // Probing is asynchronous now; render when it finishes rather than blocking the key handler.
  void (async () => {
    for (const item of targets) await runHarnessProbe(item);
    render();
  })();
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
    insideCollection: libraryController.collectionId !== undefined,
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
      void libraryController.applyPending();
      break;
    case "cancel":
      void libraryController.cancelPending();
      break;
    case "open-palette":
      shellOverlays.openPalette();
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
      selection.index = 0;
      renderNavigation();
      break;
    case "back-collection": {
      libraryController.backCollection();
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
      libraryController.startEnable();
      break;
    case "disable":
      libraryController.startDisable();
      break;
    case "invocation":
      libraryController.startInvocation();
      break;
    case "refresh":
      void libraryController.refreshLibrary();
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
if (process.env.SKIT_TUI_SNAPSHOT_PALETTE === "1") shellOverlays.openPalette();
if (process.env.SKIT_TUI_SNAPSHOT_DOCUMENT === "1") {
  if (sections[variant]?.key === "skills" && skillNavigation.view === "groups") {
    skillNavigation = { view: "skills", group: skillGroups[0]! };
    selection.index = 0;
    render();
  }
  openSelectedSkill();
}

if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY && sections[variant]?.key === "library") {
  if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY === "enable") libraryController.startEnable();
  if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY === "disable") libraryController.startDisable();
  if (process.env.SKIT_TUI_SNAPSHOT_LIBRARY === "confirm")
    await libraryController.previewSelected({ kind: "global" });
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
