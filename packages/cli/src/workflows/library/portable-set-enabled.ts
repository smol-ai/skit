import {
  canonicalJson,
  LibraryStore,
  withLibraryWriter,
  type LibraryState,
  type PortableDeviceBinding,
  type PortableRepositoryBinding,
  type Digest,
} from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { OptionCombinationInvalid } from "../../handlers/failures.js";
import { validateSetEnabledInvocation, type SetEnabledInvocation } from "./set-enabled.js";
import type { InventoryRootOptions } from "../../projection/roots.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";

export class PortableSetEnabledMissing extends Schema.TaggedError<PortableSetEnabledMissing>()(
  "Library.PortableSetEnabledMissing",
  { query: Schema.String, message: Schema.String },
) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit list` to find a retained Collection or Skill.";
}
export class PortableSetEnabledAmbiguous extends Schema.TaggedError<PortableSetEnabledAmbiguous>()(
  "Library.PortableSetEnabledAmbiguous",
  { query: Schema.String, message: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use a Collection ID or Skill Version ID to select one match.";
}

export interface PortableSetEnabledOptions {
  readonly query: string;
  readonly all: boolean;
  readonly selectedSkills?: readonly string[];
  readonly invocation: SetEnabledInvocation;
  readonly roots: InventoryRootOptions;
  readonly variantsPath: string;
  readonly adoptionObservedHash?: Digest;
}

export class PortableSetEnabledStale extends Schema.TaggedError<PortableSetEnabledStale>()(
  "Library.PortableSetEnabledStale",
  { message: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Preview the Binding change again.";
}

export const libraryStateRevision = (state: LibraryState): string =>
  createHash("sha256").update(canonicalJson(state)).digest("hex");

const isDeviceBinding = (
  binding: PortableDeviceBinding | PortableRepositoryBinding,
): binding is PortableDeviceBinding => binding.scope.kind === "global";

/** Resolve against retained membership, never a Source or a synthesized Release. */
export const previewLibraryBindings = Effect.fn("LibraryBindings.preview")(function* (
  state: LibraryState,
  options: PortableSetEnabledOptions,
) {
  yield* Effect.fromResult(validateSetEnabledInvocation(options.invocation));
  const collectionMatches = state.collections.flatMap((collection) => {
    const members = state.skills.filter(
      (skill) => skill.collection_id === collection.collection_id,
    );
    const collectionMatch = [collection.collection_id, collection.label].includes(
      options.query,
    );
    const skill = members.find(
      (member) =>
        member.name === options.query ||
        member.skill_id === options.query ||
        member.versions.some((version) => version.skill_version_id === options.query),
    );
    return collectionMatch || skill !== undefined
      ? [{ collection, members, collectionMatch, skill }]
      : [];
  });
  const standaloneMatches = state.skills
    .filter((skill) => skill.collection_id === undefined)
    .filter(
      (skill) =>
        skill.name === options.query ||
        skill.skill_id === options.query ||
        skill.versions.some((version) => version.skill_version_id === options.query),
    )
    .map((skill) => ({
      collection: undefined,
      members: [skill],
      collectionMatch: false,
      skill,
    }));
  const matches = [...collectionMatches, ...standaloneMatches];
  if (matches.length === 0)
    return yield* new PortableSetEnabledMissing({
      query: options.query,
      message: `No retained Collection or Skill matches ${options.query}`,
    });
  if (matches.length !== 1)
    return yield* new PortableSetEnabledAmbiguous({
      query: options.query,
      message: `More than one retained Collection or Skill matches ${options.query}`,
    });
  const match = matches[0];
  if (match === undefined)
    return yield* new PortableSetEnabledMissing({
      query: options.query,
      message: `No retained Collection or Skill matches ${options.query}`,
    });
  if (options.all && !match.collectionMatch)
    return yield* new OptionCombinationInvalid({
      detail: "--all requires a Collection, not one contained Skill",
    });
  if (options.all && options.selectedSkills !== undefined)
    return yield* new OptionCombinationInvalid({
      detail: "Choose either --all or selected Skills",
    });
  if (options.selectedSkills !== undefined && !match.collectionMatch)
    return yield* new OptionCombinationInvalid({
      detail: "Selected Skills require a Collection",
    });
  if (
    !options.all &&
    options.selectedSkills === undefined &&
    match.collectionMatch &&
    match.members.length !== 1
  )
    return yield* new OptionCombinationInvalid({
      detail: "Select a contained Skill or use --all for this Collection",
    });
  if (options.selectedSkills?.some((name) => !match.members.some((member) => member.name === name)))
    return yield* new OptionCombinationInvalid({
      detail: "Selected Skill is absent from this Collection",
    });
  const skills = [
    ...new Set(
      options.selectedSkills ??
        (options.all || match.collectionMatch
          ? match.members.map((member) => member.name)
          : match.skill === undefined
            ? []
            : [match.skill.name]),
    ),
  ];
  const skillIds = skills.map(
    (name) => match.members.find((member) => member.name === name)!.skill_id,
  );
  const scope = options.invocation.scope;
  const bindings: Array<PortableDeviceBinding | PortableRepositoryBinding> = [];
  for (const harness of options.invocation.harnesses) {
    const existing =
      scope.kind === "global"
        ? state.global_bindings.find(
            (binding) =>
              binding.harness === harness,
          )
        : state.local_bindings.find(
            (binding) =>
              binding.harness === harness &&
              resolve(binding.scope.root) === resolve(scope.root),
          );
    const names = new Set(existing?.skills ?? []);
    for (const skillId of skillIds)
      if (options.invocation.enabled) names.add(skillId);
      else names.delete(skillId);
    const policies = { ...existing?.invocation_policies };
    for (const skillId of skillIds) {
      if (!options.invocation.enabled || options.invocation.invocation === "declared")
        delete policies[skillId];
      else if (options.invocation.invocation !== undefined)
        policies[skillId] = options.invocation.invocation;
    }
    if (existing === undefined && names.size === 0) continue;
    const common = {
      harness,
      skills: [...names].sort(),
      ...(Object.keys(policies).length ? { invocation_policies: policies } : {}),
    };
    const binding: PortableDeviceBinding | PortableRepositoryBinding =
      scope.kind === "global"
        ? { ...common, scope: { kind: "global" } }
        : { ...common, scope: { kind: "repository", root: scope.root } };
    bindings.push(binding);
  }
  const changed = bindings.some((binding) => {
    const existing = isDeviceBinding(binding)
      ? state.global_bindings.find(
          (item) =>
            item.harness === binding.harness,
        )
      : state.local_bindings.find(
          (item) =>
            item.harness === binding.harness &&
            resolve(item.scope.root) === resolve(binding.scope.root),
        );
    return canonicalJson(existing ?? null) !== canonicalJson(binding);
  });
  return {
    subject_id: match.collection?.collection_id ?? match.skill!.skill_id,
    skills,
    harnesses: [...options.invocation.harnesses],
    scope,
    enabled: options.invocation.enabled,
    ...(options.invocation.invocation === undefined
      ? {}
      : { invocation: options.invocation.invocation }),
    changed,
    bindings,
  };
});

/** Authoritatively reload, commit Binding intent, then reconcile Projection reality. */
export const applyLibraryBindings = Effect.fn("LibraryBindings.apply")(function* (
  state: LibraryState,
  options: PortableSetEnabledOptions,
) {
  const plan = yield* previewLibraryBindings(state, options);
  if (options.invocation.dryRun) return { kind: "plan" as const, value: plan };
  const expectedRevision = libraryStateRevision(state);
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      const store = yield* LibraryStore;
      const current = yield* store.load;
      if (libraryStateRevision(current) !== expectedRevision)
        return yield* new PortableSetEnabledStale({
          message: "Library changed after this Binding change was previewed",
        });
      if (plan.changed) {
        const global_bindings = [...current.global_bindings];
        const local_bindings = [...current.local_bindings];
        for (const binding of plan.bindings) {
          if (isDeviceBinding(binding)) {
            const index = global_bindings.findIndex(
              (item) =>
                item.harness === binding.harness,
            );
            if (index < 0) global_bindings.push(binding);
            else global_bindings[index] = binding;
          } else {
            const index = local_bindings.findIndex(
              (item) =>
                item.harness === binding.harness &&
                resolve(item.scope.root) === resolve(binding.scope.root),
            );
            if (index < 0) local_bindings.push(binding);
            else local_bindings[index] = binding;
          }
        }
        yield* store.publish({ ...current, global_bindings, local_bindings });
      }
      const reconciled = yield* reconcileLibraryProjections({
        roots: options.roots,
        variantsPath: options.variantsPath,
        onlyBindings: plan.bindings,
        ...(options.adoptionObservedHash === undefined
          ? {}
          : { adoptionObservedHash: options.adoptionObservedHash }),
      });
      let result = plan;
      if (!options.invocation.enabled) {
        const settled = yield* store.load;
        const global_bindings = settled.global_bindings.filter(
          (binding) => binding.skills.length > 0,
        );
        const local_bindings = settled.local_bindings.filter(
          (binding) => binding.skills.length > 0,
        );
        if (
          global_bindings.length !== settled.global_bindings.length ||
          local_bindings.length !== settled.local_bindings.length
        )
          yield* store.publish({ ...settled, global_bindings, local_bindings });
        result = {
          ...plan,
          bindings: plan.bindings.filter((binding) => binding.skills.length > 0),
        };
      }
      return {
        kind: "applied" as const,
        value: { ...result, projections: reconciled.outcomes },
      };
    }),
  );
});
