import { Effect } from "effect";
import { SkitConfiguration } from "@smolai/skit-core";
import * as Session from "@smolai/skit-core/library/session";
export {
  type ScopeRow,
  type LibrarySkillRow,
  type PreviewFacts,
  type PendingLibraryChange,
  type LibraryActionOutcome,
  type LibrarySessionState,
  libraryPolicyAfter,
  proposeLibraryEnable,
  proposeLibraryDisable,
  libraryCollectionScopes,
  proposeLibraryCollectionChange,
  proposeLibraryInvocation,
  cancelLibraryChange,
  confirmLibraryChange,
} from "@smolai/skit-core/library/session";
export const openLibrarySession = (configuration: Session.SetEnabledConfiguration) =>
  Effect.flatMap(SkitConfiguration, (paths) =>
    Session.openLibrarySession(paths.skitHome, configuration),
  );
export const readLibrarySkillContent = (skillVersionId: string) =>
  Effect.flatMap(SkitConfiguration, (paths) =>
    Session.readLibrarySkillContent(paths.skitHome, skillVersionId),
  );
