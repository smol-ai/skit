import { Data } from "effect";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

export class CollectionRemovalMissing
  extends Data.TaggedError("Library.CollectionRemovalMissing")<{
    collection_id: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the retained Collections.";
  get message(): string {
    return `Collection is no longer retained: ${this.collection_id}`;
  }
}

export class SkillRemovalRequiresCollection
  extends Data.TaggedError("Library.SkillRemovalRequiresCollection")<{
    skill_id: string;
    collection_id: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get remediation(): string {
    return `Remove the whole Collection with \`skit remove ${this.collection_id}\`, or disable just this Skill.`;
  }
  get message(): string {
    return `${this.skill_id} can be removed only with its Collection ${this.collection_id}`;
  }
}
