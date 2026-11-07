import * as Library from "@smolai/skit-core/library";
import { resolve } from "node:path";
import { Effect } from "effect";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import {
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
  type LibrarySessionState,
  type PendingLibraryChange,
  type LibraryActionOutcome,
  type LibrarySkillRow,
  type ScopeRow,
  type InstallScope,
  type InvocationOption,
} from "@smolai/skit-core/library/session";
import { libraryRows, type LibraryCollectionRow } from "../shell/presentation";

interface ChooserOption {
  value: string;
  label: string;
  hint?: string;
}

export interface Chooser {
  title: string;
  /** What the operator needs to know before deciding, shown above the options. */
  briefing?: string;
  options: readonly ChooserOption[];
  choose: (value: string) => void | Promise<void>;
}

type Requirements = Library.Service | Effect.Services<ReturnType<typeof confirmLibraryChange>>;
type Transition = <Error>(
  update: (state: LibrarySessionState) => Effect.Effect<LibrarySessionState, Error, Requirements>,
) => Promise<LibraryActionOutcome | undefined>;
interface Options {
  readonly host: {
    readonly state: LibrarySessionState | undefined;
    readonly transition: Transition;
  };
  readonly home: string;
  readonly configuration: InventoryRootOptions;
  readonly active: () => boolean;
  readonly openChooser: (chooser: Chooser) => void;
  readonly openConfirm: (pending: PendingLibraryChange) => void;
  readonly closeConfirm: () => void;
  readonly render: () => void;
  readonly refreshListingBudgets: () => Promise<void>;
}

/** Library navigation and interaction flow; the host alone runs and serializes core operations. */
export function createLibraryController(options: Options) {
  const libraryHost = options.host;
  const { openChooser, openConfirm, closeConfirm, render, refreshListingBudgets } = options;
  let collectionId: string | undefined;
  let selectedIndex = 0;
  let showNoChangeNotice = false;
  const rows = () => libraryRows(libraryHost.state?.skills ?? [], collectionId);
  const transitionLibrary: Transition = async (update) => {
    const outcome = await libraryHost.transition(update);
    if (outcome?.kind === "applied") await refreshListingBudgets();
    return outcome;
  };
  function selectedLibraryRow(): LibrarySkillRow | undefined {
    if (!options.active()) return;
    const item = rows()[selectedIndex];
    return item?.kind === "library-skill" ? item.row : undefined;
  }
  function selectedLibraryCollection(): LibraryCollectionRow | undefined {
    if (!options.active()) return;
    const item = rows()[selectedIndex];
    return item?.kind === "library-collection" ? item : undefined;
  }
  const ALL_SCOPES = "all";
  function afterProposal(outcome: LibraryActionOutcome | undefined): void {
    if (!outcome) return;
    showNoChangeNotice = outcome.kind === "unchanged";
    render();
    if (outcome.kind === "preview" && libraryHost.state?.pending) {
      openConfirm(libraryHost.state.pending);
    }
  }

  function chooseScopeThen(next: (scope: InstallScope) => void | Promise<void>): void {
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

  function startEnable(): void {
    const collection = selectedLibraryCollection();
    if (collection && libraryHost.state) {
      chooseScopeThen(async (scope) =>
        afterProposal(
          await transitionLibrary((state) =>
            proposeLibraryCollectionChange(state, collection.collectionId, true, [scope]),
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
                ? proposeLibraryCollectionChange(state, row.collectionId, true, [scope])
                : proposeLibraryEnable(state, row, { scope }),
            ),
          ),
        ),
    });
  }

  function disableCollection(collectionId: string): void {
    if (!libraryHost.state) return;
    const scopes = libraryCollectionScopes(libraryHost.state, collectionId);
    if (!scopes.length) return;
    const disable = async (selectedScopes: readonly InstallScope[]) =>
      afterProposal(
        await transitionLibrary((state) =>
          proposeLibraryCollectionChange(state, collectionId, false, selectedScopes),
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
            await transitionLibrary((state) => proposeLibraryDisable(state, row, scopes)),
          );
        if (row.scopes.length === 1) void disable(row.scopes);
        else
          openChooser({
            title: DESTINATION_QUESTION,
            options: [
              { value: ALL_SCOPES, label: "All shown" },
              ...scopeChooserOptions(row.scopes),
            ],
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
              proposeLibraryInvocation(state, row, scopeRow, value as InvocationOption),
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
    await transitionLibrary((state) =>
      Effect.map(
        Effect.flatMap(Library.Service, (library) => library.session.open()),
        (session) => ({
          ...session,
          ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
        }),
      ),
    );
    await refreshListingBudgets();
    render();
  }

  return {
    get collectionId() {
      return collectionId;
    },
    get selectedIndex() {
      return selectedIndex;
    },
    set selectedIndex(index: number) {
      selectedIndex = index;
    },
    get showNoChangeNotice() {
      return showNoChangeNotice;
    },
    get skills() {
      return libraryHost.state?.skills ?? [];
    },
    reset() {
      collectionId = undefined;
      selectedIndex = 0;
      showNoChangeNotice = false;
    },
    openCollection(id: string) {
      collectionId = id;
      selectedIndex = 0;
    },
    backCollection() {
      const previous = collectionId;
      collectionId = undefined;
      selectedIndex = rows().findIndex(
        (row) => row.kind === "library-collection" && row.collectionId === previous,
      );
    },
    selectRequestedItem(name: string) {
      const collectionIndex = rows().findIndex((row) => row.name === name);
      if (collectionIndex >= 0) selectedIndex = collectionIndex;
      else {
        const skill = libraryHost.state?.skills.find((row) => row.name === name);
        if (skill) {
          collectionId = skill.collectionId;
          selectedIndex = rows().findIndex(
            (row) =>
              row.kind === "library-skill" && row.row.skillVersionId === skill.skillVersionId,
          );
        }
      }
    },
    async previewSelected(scope: InstallScope) {
      const collection = selectedLibraryCollection();
      if (collection && libraryHost.state)
        afterProposal(
          await transitionLibrary((state) =>
            proposeLibraryCollectionChange(state, collection.collectionId, true, [scope]),
          ),
        );
      const row = selectedLibraryRow();
      if (row && libraryHost.state)
        afterProposal(
          await transitionLibrary((state) => proposeLibraryEnable(state, row, { scope })),
        );
    },
    startEnable,
    startDisable,
    startInvocation,
    applyPending,
    cancelPending,
    refreshLibrary,
  };
}
