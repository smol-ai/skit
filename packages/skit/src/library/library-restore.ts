/** Compatibility surface while sync's local effects migrate into Library. */
export {
  RestoreInvalid,
  SourceRestoreInvalid,
  prepareRestore,
  strandedByRestore,
  blendRestoredState,
  type RestoreOptions,
} from "./internal/content/restore.js";
