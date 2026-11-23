import { Context, Effect, Schema } from "effect";
import { Enabled } from "../library-contracts.js";
import { InvocationPolicies, Repository, DeviceSkillSelection } from "../device-state.js";
import {
  CollectionId,
  CollectionVersionId,
  ImportId,
  SkillId,
  SkillVersionId,
} from "../entity-ids.js";
import { canonicalJson } from "../../shared/json.js";
import { InvalidLibraryState } from "../failures.js";
import { prepareEnabledSet } from "../enabled.js";
import { InvocationPolicy } from "../../artifact/invocation-policy.js";
import { UndoScope } from "../recovery-facts.js";
import { enabledItemKey } from "../library-contracts.js";
import { prepareRowDifference } from "./difference.js";

const source = Schema.Struct({
  collectionId: CollectionId,
  importId: ImportId,
  collectionVersionId: CollectionVersionId,
});
const membership = Schema.Struct({ collectionId: CollectionId, skillIds: Schema.Array(SkillId) });
const version = Schema.Struct({
  skillId: SkillId,
  selected: Schema.NullOr(SkillVersionId),
  local: Schema.NullOr(SkillVersionId),
});
export const SetupIntent = Schema.Struct({
  global: Schema.Struct({
    enabled: Schema.Array(Enabled),
    invocation_policies: Schema.optionalKey(InvocationPolicies),
  }),
  repositories: Schema.Array(Repository),
  device: Schema.NullOr(DeviceSkillSelection),
  sources: Schema.optionalKey(Schema.Array(source)),
  memberships: Schema.optionalKey(Schema.Array(membership)),
  versions: Schema.Array(version),
});
export type SetupIntent = typeof SetupIntent.Type;
const mode = Schema.NullOr(Schema.Literals(["choose", "follow-account"]));
const scope = Schema.Struct({
  scope: UndoScope,
  beforePresent: Schema.Boolean,
  afterPresent: Schema.Boolean,
  enabled: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      before: Schema.optionalKey(Enabled),
      after: Schema.optionalKey(Enabled),
    }),
  ),
  policies: Schema.Array(
    Schema.Struct({
      key: SkillId,
      before: Schema.optionalKey(InvocationPolicy),
      after: Schema.optionalKey(InvocationPolicy),
    }),
  ),
});
export const SetupIntentChanges = Schema.Struct({
  scopes: Schema.Array(scope),
  device: Schema.optionalKey(Schema.Struct({ before: mode, after: mode })),
  sources: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      before: Schema.optionalKey(source),
      after: Schema.optionalKey(source),
    }),
  ),
  memberships: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      before: Schema.optionalKey(membership),
      after: Schema.optionalKey(membership),
      followedBefore: Schema.Boolean,
    }),
  ),
  versions: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      before: Schema.optionalKey(version),
      after: Schema.optionalKey(version),
    }),
  ),
});
export type SetupIntentChanges = typeof SetupIntentChanges.Type;
export const CurrentSetupOperation = Context.Reference<string | undefined>(
  "skit/library/CurrentSetupOperation",
  { defaultValue: () => undefined },
);

/** Record changed keys, not list positions or whole scope snapshots. */
export const prepareSetupChanges = Effect.fn("Setup.prepareIntentChanges")(function* (
  before: SetupIntent,
  after: SetupIntent,
  path: string,
) {
  const [prior, desired] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([SetupIntent, SetupIntent]),
  )([before, after]).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
  const prepare = (intent: SetupIntent) => ({
    ...intent,
    global: prepareEnabledSet(intent.global),
    repositories: intent.repositories.map((row) => prepareEnabledSet(row)),
    device: intent.device?.mode === "choose" ? prepareEnabledSet(intent.device) : intent.device,
    memberships: (intent.memberships ?? []).map((row) => ({
      ...row,
      skillIds: [...row.skillIds].sort(),
    })),
  });
  const a = prepare(prior),
    b = prepare(desired);
  const lists: Array<{
    scope: UndoScope;
    before?: SetupIntent["global"];
    after?: SetupIntent["global"];
  }> = [
    { scope: { _tag: "Account" }, before: a.global, after: b.global },
    {
      scope: { _tag: "Device" },
      ...(a.device?.mode === "choose" ? { before: a.device } : {}),
      ...(b.device?.mode === "choose" ? { after: b.device } : {}),
    },
  ];
  for (const root of new Set([...a.repositories, ...b.repositories].map((row) => row.root))) {
    const before = a.repositories.find((row) => row.root === root),
      after = b.repositories.find((row) => row.root === root);
    lists.push({
      scope: { _tag: "Repository", root },
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
  }
  const scopes: Array<typeof scope.Type> = [];
  for (const list of lists) {
    const enabled = prepareRowDifference(
      list.before?.enabled ?? [],
      list.after?.enabled ?? [],
      enabledItemKey,
    ).changes;
    const rows = (policies: InvocationPolicies | undefined) =>
      Object.entries(policies ?? {}).map(([key, value]) => ({ key: SkillId.make(key), value }));
    const policies = prepareRowDifference(
      rows(list.before?.invocation_policies),
      rows(list.after?.invocation_policies),
      (row) => row.key,
    ).changes.map((row) => ({
      key: SkillId.make(row.key),
      ...(row.before === undefined ? {} : { before: row.before.value }),
      ...(row.after === undefined ? {} : { after: row.after.value }),
    }));
    if (
      enabled.length ||
      policies.length ||
      (list.before !== undefined) !== (list.after !== undefined)
    )
      scopes.push({
        scope: list.scope,
        beforePresent: list.before !== undefined,
        afterPresent: list.after !== undefined,
        enabled,
        policies,
      });
  }
  const priorLists = [
    a.global,
    ...a.repositories,
    ...(a.device?.mode === "choose" ? [a.device] : []),
  ];
  const oldMode = a.device?.mode ?? null,
    newMode = b.device?.mode ?? null;
  return {
    scopes,
    ...(oldMode === newMode ? {} : { device: { before: oldMode, after: newMode } }),
    sources: prepareRowDifference(a.sources ?? [], b.sources ?? [], (row) => row.collectionId)
      .changes,
    versions: prepareRowDifference(a.versions, b.versions, (row) => row.skillId).changes,
    memberships: prepareRowDifference(
      a.memberships,
      b.memberships,
      (row) => row.collectionId,
    ).changes.map((row) => ({
      ...row,
      followedBefore: priorLists.some((list) =>
        list.enabled.some((item) => "collection" in item && item.collection === row.key),
      ),
    })),
  } satisfies SetupIntentChanges;
});

/** Merge deltas by identity. Only after values advance; original before values never get rebuilt. */
export const prepareSetupProgress = Effect.fn("Setup.prepareIntentProgress")(function* (
  saved: SetupIntentChanges,
  before: SetupIntent,
  after: SetupIntent,
  path: string,
) {
  const fresh = yield* prepareSetupChanges(before, after, path);
  const keepBefore = <A>(
    prior: readonly { readonly key: string; readonly before?: A; readonly after?: A }[],
    next: readonly { readonly key: string; readonly before?: A; readonly after?: A }[],
  ) => {
    const rows = new Map(prior.map((row) => [row.key, row]));
    for (const change of next) {
      const first = rows.get(change.key);
      rows.set(
        change.key,
        first === undefined
          ? change
          : {
              key: change.key,
              ...(first.before === undefined ? {} : { before: first.before }),
              ...(change.after === undefined ? {} : { after: change.after }),
            },
      );
    }
    return [...rows.values()].filter(
      (row) => canonicalJson(row.before) !== canonicalJson(row.after),
    );
  };
  const scopes = [...saved.scopes];
  for (const change of fresh.scopes) {
    const index = scopes.findIndex(
      (row) => canonicalJson(row.scope) === canonicalJson(change.scope),
    );
    const prior = scopes[index];
    if (!prior) scopes.push(change);
    else
      scopes[index] = {
        ...change,
        beforePresent: prior.beforePresent,
        enabled: keepBefore(prior.enabled, change.enabled),
        policies: keepBefore(prior.policies, change.policies).map((row) => ({
          ...row,
          key: SkillId.make(row.key),
        })),
      };
  }
  const originalFollow = (collectionId: string) => {
    const candidates: Array<{ scope: UndoScope; list?: SetupIntent["global"] }> = [
      { scope: { _tag: "Account" }, list: before.global },
      {
        scope: { _tag: "Device" },
        ...(before.device?.mode === "choose" ? { list: before.device } : {}),
      },
    ];
    const roots = new Set([
      ...before.repositories.map((row) => row.root),
      ...saved.scopes.flatMap((row) => (row.scope._tag === "Repository" ? [row.scope.root] : [])),
    ]);
    for (const root of roots) {
      const list = before.repositories.find((row) => row.root === root);
      candidates.push({ scope: { _tag: "Repository", root }, ...(list ? { list } : {}) });
    }
    return candidates.some(({ scope, list }) => {
      const change = saved.scopes.find((row) => canonicalJson(row.scope) === canonicalJson(scope));
      if (change?.beforePresent === false) return false;
      const item = change?.enabled.find((row) => row.key === `collection:${collectionId}`);
      return item === undefined
        ? list?.enabled.some((row) => "collection" in row && row.collection === collectionId) ===
            true
        : item.before !== undefined;
    });
  };
  const device = fresh.device
    ? {
        before: saved.device ? saved.device.before : fresh.device.before,
        after: fresh.device.after,
      }
    : saved.device;
  return {
    scopes: scopes.filter(
      (row) => row.beforePresent !== row.afterPresent || row.enabled.length || row.policies.length,
    ),
    ...(device === undefined || device.before === device.after ? {} : { device }),
    sources: keepBefore(saved.sources, fresh.sources),
    versions: keepBefore(saved.versions, fresh.versions),
    memberships: keepBefore(saved.memberships, fresh.memberships).map((row) => ({
      ...row,
      followedBefore:
        saved.memberships.find((prior) => prior.key === row.key)?.followedBefore ??
        originalFollow(row.key),
    })),
  } satisfies SetupIntentChanges;
});
