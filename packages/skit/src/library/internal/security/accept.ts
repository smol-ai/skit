import { Revision, type Snapshot } from "../../snapshot.js";
import { Clock, Effect, Option, Schema, Struct } from "effect";
import { Hash } from "../../../shared/hash.js";
import { SkillAssessmentAcceptance } from "../../assessment-acceptance.js";
import { type SkillSecurityReview } from "../../../auditing/skill-contracts.js";
import { AcceptanceIncomplete, SecurityFindingAbsent } from "../../failures.js";
import * as InstalledSkills from "../../installed-skills.js";
import { collectionVersionPath } from "../../collection-version.js";
import { InvalidIntent } from "../../enabled-plan.js";
import { StalePlan } from "../../library-plan.js";
import { emptyLibraryState } from "../../library-state.js";

import { applyReviewed, planIdOf, planningState } from "../../reviewed-plan.js";
import { LibraryWriter, libraryOriginalsPath } from "../../store/library-store.js";
import { securityReview, securitySkill } from "./review.js";

export const AcceptFindingIntent = Schema.TaggedStruct("AcceptFinding", {
  query: Schema.String,
  fingerprint: Hash,
  principal: Schema.String,
  rationale: Schema.String,
  expiresAt: Schema.OptionFromOptionalKey(Schema.String),
});
export type AcceptFindingIntent = typeof AcceptFindingIntent.Type;
const AcceptFindingChange = Schema.Struct({
  acceptance: SkillAssessmentAcceptance.mapFields(Struct.omit(["acceptedAt"])),
});
export const AcceptFindingPlan = Schema.TaggedStruct("AcceptFinding", {
  intent: AcceptFindingIntent,
  baseRevision: Revision,
  planId: Hash,
  change: AcceptFindingChange,
  folders: Schema.Array(InstalledSkills.Folder),
});
export type AcceptFindingPlan = typeof AcceptFindingPlan.Type;
interface AcceptFindingResult {
  readonly acceptance: SkillAssessmentAcceptance;
  readonly review: SkillSecurityReview;
}
export interface AcceptFindingOutcome {
  readonly _tag: "AcceptFinding";
  readonly result: AcceptFindingResult;
}
export const planAcceptance = Effect.fn("Library.planAcceptance")(function* (
  home: string,
  input: AcceptFindingIntent,
  options: { readonly base: Snapshot },
) {
  const files = yield* InstalledSkills.Service;
  const intent = yield* Schema.encodeEffect(AcceptFindingIntent, { onExcessProperty: "error" })(
    input,
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AcceptFindingIntent)),
    Effect.mapError(() => new InvalidIntent({ intent: "AcceptFinding" })),
  );
  const state = yield* planningState(home, options.base);
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
  const originals = libraryOriginalsPath(home);
  const review = yield* securityReview(state, originals, intent.query);
  if (!review.audit.findings.some((finding) => finding.fingerprint === intent.fingerprint))
    return yield* new SecurityFindingAbsent({ fingerprint: intent.fingerprint });
  const { tree } = yield* securitySkill(state, review.skill_version_id);
  const reviewed: Omit<AcceptFindingPlan, "planId"> = {
    _tag: "AcceptFinding",
    intent,
    baseRevision: options.base.revision,
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
    folders: [yield* files.inspect(collectionVersionPath(originals, tree.hash))],
  };
  const encoded = yield* Schema.encodeEffect(AcceptFindingIntent)(intent);
  return {
    ...reviewed,
    planId: yield* planIdOf({ ...reviewed, intent: encoded }),
  } satisfies AcceptFindingPlan;
});

export const applyAcceptance = Effect.fn("Library.applyAcceptance")(function* (
  home: string,
  input: AcceptFindingPlan,
) {
  const files = yield* InstalledSkills.Service;
  const plan = yield* Schema.encodeEffect(AcceptFindingPlan, { onExcessProperty: "error" })(
    input,
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AcceptFindingPlan)),
    Effect.mapError(() => new StalePlan({ reason: { _tag: "PlanInvalid", kind: "acceptance" } })),
  );
  const check = (folders: AcceptFindingPlan["folders"]) =>
    files
      .check(folders)
      .pipe(
        Effect.catchTag("Library.InstalledSkillsChanged", () =>
          Effect.fail(new StalePlan({ reason: { _tag: "ContentChanged", kind: "skill" } })),
        ),
      );
  return yield* applyReviewed(
    home,
    plan,
    // The reviewed bytes are checked before planning again reads them.
    (base) => Effect.andThen(check(plan.folders), planAcceptance(home, plan.intent, { base })),
    (again, base) =>
      Effect.gen(function* () {
        yield* check(again.folders);
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
        yield* (yield* LibraryWriter).save(next, state);
        const review = yield* securityReview(
          next,
          libraryOriginalsPath(home),
          acceptance.skill_version_id,
        );
        return {
          _tag: "AcceptFinding",
          result: { acceptance, review },
        } satisfies AcceptFindingOutcome;
      }),
  );
});
export type AcceptFindingPlanError = Effect.Error<ReturnType<typeof planAcceptance>>;
export type AcceptFindingApplyError = Effect.Error<ReturnType<typeof applyAcceptance>>;
