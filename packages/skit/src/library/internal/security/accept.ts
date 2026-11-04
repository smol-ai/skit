import { Clock, Effect, Option, Schema, Struct } from "effect";
import { Hash, SkillAssessmentAcceptance, type SkillSecurityReview } from "../../../contracts.js";
import {
  AcceptanceIncomplete,
  InvalidLibraryState,
  SecurityFindingAbsent,
} from "../../../failures.js";
import { canonicalJson } from "../../../shared/json.js";
import { sha256Hash } from "../../../shared/hash.js";
import { InstalledSkills } from "../../installed-skills.js";
import { collectionVersionPath } from "../../collection-version.js";
import { InvalidIntent } from "../../enabled-plan.js";
import { StalePlan } from "../../library-plan.js";
import { emptyLibraryState, LibraryState } from "../../library-state.js";
import { Revision, snapshotOf, type Snapshot } from "../../snapshot.js";
import { LibraryStore, withLibraryWriter } from "../../store/library-store.js";
import { securityReview, securitySkill } from "./review.js";

export const AcceptFindingIntent = Schema.TaggedStruct("AcceptFinding", {
  query: Schema.String,
  fingerprint: Hash,
  principal: Schema.String,
  rationale: Schema.String,
  expiresAt: Schema.OptionFromOptionalKey(Schema.String),
});
export type AcceptFindingIntent = typeof AcceptFindingIntent.Type;
export const AcceptFindingChange = Schema.Struct({
  acceptance: SkillAssessmentAcceptance.mapFields(Struct.omit(["acceptedAt"])),
});
export const AcceptFindingPlan = Schema.TaggedStruct("AcceptFinding", {
  intent: AcceptFindingIntent,
  baseRevision: Schema.String,
  planId: Hash,
  change: AcceptFindingChange,
  folders: Schema.Array(InstalledSkills.Folder),
});
export type AcceptFindingPlan = typeof AcceptFindingPlan.Type;
export interface AcceptFindingResult {
  readonly acceptance: SkillAssessmentAcceptance;
  readonly review: SkillSecurityReview;
}
export interface AcceptFindingOutcome {
  readonly _tag: "AcceptFinding";
  readonly result: AcceptFindingResult;
}
const planHash = Effect.fn("Library.acceptancePlanHash")(function* (
  plan: Omit<AcceptFindingPlan, "planId">,
) {
  const intent = yield* Schema.encodeEffect(AcceptFindingIntent)(plan.intent);
  return yield* sha256Hash(new TextEncoder().encode(canonicalJson({ ...plan, intent })));
});

export const planAcceptance = Effect.fn("Library.planAcceptance")(function* (
  input: AcceptFindingIntent,
  options: { readonly base: Snapshot },
) {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const intent = yield* Schema.encodeEffect(AcceptFindingIntent, { onExcessProperty: "error" })(
    input,
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AcceptFindingIntent)),
    Effect.mapError(() => new InvalidIntent({ detail: "invalid acceptance intent" })),
  );
  const base = structuredClone(options.base);
  const state = base._tag === "Present" ? base.state : emptyLibraryState();
  yield* LibraryState.makeEffect(state).pipe(
    Effect.mapError(
      () =>
        new InvalidLibraryState({ path: store.statePath, detail: "invalid acceptance snapshot" }),
    ),
  );
  const actual = snapshotOf(
    base._tag === "Present" ? { present: true, state } : { present: false },
  ).revision;
  if (base.revision !== actual)
    return yield* new StalePlan({
      message: "The displayed Library snapshot changed",
      expected: base.revision,
      actual,
    });
  if (!intent.principal.trim() || !intent.rationale.trim())
    return yield* new AcceptanceIncomplete({ reason: "missing" });
  let expiresAt: string | undefined;
  if (Option.isSome(intent.expiresAt) && intent.expiresAt.value) {
    const value = intent.expiresAt.value;
    const parsed = Date.parse(value);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(parsed)
    )
      return yield* new AcceptanceIncomplete({ reason: "invalid-expiry" });
    if (parsed <= (yield* Clock.currentTimeMillis))
      return yield* new AcceptanceIncomplete({ reason: "expiry-in-past" });
    expiresAt = new Date(parsed).toISOString();
  }
  const review = yield* securityReview(state, store.originalsPath, intent.query);
  if (!review.audit.findings.some((finding) => finding.fingerprint === intent.fingerprint))
    return yield* new SecurityFindingAbsent({ fingerprint: intent.fingerprint });
  const { tree } = yield* securitySkill(state, review.skill_version_id);
  const reviewed: Omit<AcceptFindingPlan, "planId"> = {
    _tag: "AcceptFinding",
    intent,
    baseRevision: base.revision,
    change: {
      acceptance: {
        fingerprint: intent.fingerprint,
        artifactContentHash: review.artifactContentHash,
        skill_version_id: review.skill_version_id,
        context: "project",
        principal: intent.principal.trim(),
        rationale: intent.rationale.trim(),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    },
    folders: [yield* files.inspect(collectionVersionPath(store.originalsPath, tree.hash))],
  };
  return { ...reviewed, planId: yield* planHash(reviewed) } satisfies AcceptFindingPlan;
});

export const applyAcceptance = Effect.fn("Library.applyAcceptance")(function* (
  input: AcceptFindingPlan,
) {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const plan = yield* Schema.encodeEffect(AcceptFindingPlan, { onExcessProperty: "error" })(
    input,
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AcceptFindingPlan)),
    Effect.mapError(() => new StalePlan({ message: "Invalid acceptance plan" })),
  );
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      const base = snapshotOf(yield* store.inspect);
      if (base.revision !== plan.baseRevision)
        return yield* new StalePlan({
          message: "Library changed after acceptance was previewed",
          expected: Revision(plan.baseRevision),
          actual: base.revision,
        });
      const check = files
        .check(plan.folders)
        .pipe(
          Effect.catchTag("Library.InstalledSkillsChanged", () =>
            Effect.fail(new StalePlan({ message: "Reviewed Skill content changed" })),
          ),
        );
      yield* check;
      const again = yield* planAcceptance(plan.intent, { base });
      const { planId, ...reviewed } = plan;
      if (planId !== (yield* planHash(reviewed)) || planId !== again.planId)
        return yield* new StalePlan({ message: "The acceptance differs from the reviewed plan" });
      yield* check;
      const acceptedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      if (
        again.change.acceptance.expiresAt !== undefined &&
        again.change.acceptance.expiresAt <= acceptedAt
      )
        return yield* new AcceptanceIncomplete({ reason: "expiry-in-past" });
      const acceptance = { ...again.change.acceptance, acceptedAt };
      const state = base._tag === "Present" ? base.state : emptyLibraryState();
      const next = {
        ...state,
        assessmentAcceptances: [...(state.assessmentAcceptances ?? []), acceptance],
      };
      yield* store.save(next, state);
      const review = yield* securityReview(next, store.originalsPath, acceptance.skill_version_id);
      return {
        _tag: "AcceptFinding",
        result: { acceptance, review },
      } satisfies AcceptFindingOutcome;
    }),
  );
});
export type AcceptFindingPlanError = Effect.Error<ReturnType<typeof planAcceptance>>;
export type AcceptFindingApplyError = Effect.Error<ReturnType<typeof applyAcceptance>>;
