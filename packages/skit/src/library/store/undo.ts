import { Effect, Schema, Struct } from "effect";
import { canonicalJson, JsonObject } from "../../shared/json.js";
import { InvalidLibraryState, LibraryChanged } from "../failures.js";
import { LibraryState } from "../library-state.js";
import { InstalledSkill } from "../device-state.js";
import { checkCatalogueChange, decodeCatalogue } from "./catalogue.js";
import { saveCatalogueBase } from "./catalogue-base.js";
import { EnabledState, missingEnabledSubject } from "./enabled.js";
import {
  loadCatalogueRows,
  loadEnabledRows,
  loadInstalledSkillRows,
  saveCatalogueRows,
  saveEnabledRows,
  saveInstalledSkillRows,
} from "./rows.js";
import {
  advanceLibraryRevision,
  readDatabaseStateRevision,
  saveSetupIntentProgress,
} from "./state-file.js";
import { setupIntent } from "./intent.js";

const catalogueFields = ["collections", "skills", "collection_versions", "imports"] as const;
const enabledFields = [
  "enabled",
  "invocation_policies",
  "repositories",
  "device_skill_selection",
  "pending_device_selection_origin",
] as const;
const fields = new Set<string>([...catalogueFields, ...enabledFields, "installed_skills"]);

/** The operation transaction owns discovery, status and audit; Undo's domain writes stay narrow. */
export const saveSetupUndoState = Effect.fn("Library.saveSetupUndoState")(
  function* (path: string, next: LibraryState, base: LibraryState, revision: number) {
    if ((yield* readDatabaseStateRevision(path)).revision !== revision)
      return yield* new LibraryChanged({ path });
    yield* Schema.decodeUnknownEffect(Schema.declare(Schema.is(LibraryState)))(next);
    const [beforeDocument, nextDocument] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([JsonObject, JsonObject]),
    )([base, next]);
    for (const key of new Set([...Object.keys(beforeDocument), ...Object.keys(nextDocument)])) {
      if (
        !fields.has(key) &&
        (Object.hasOwn(beforeDocument, key) !== Object.hasOwn(nextDocument, key) ||
          canonicalJson(beforeDocument[key]) !== canonicalJson(nextDocument[key]))
      )
        return yield* new InvalidLibraryState({
          path,
          reason: { _tag: "UndoFieldChanged", field: key },
        });
    }
    const beforeCatalogue = yield* decodeCatalogue(path, beforeDocument);
    const nextCatalogue = yield* decodeCatalogue(path, nextDocument);
    const currentCatalogue = yield* decodeCatalogue(path, yield* loadCatalogueRows());
    const beforeEnabled = yield* Schema.decodeUnknownEffect(EnabledState)(
      Struct.pick(base, enabledFields),
    );
    const nextEnabled = yield* Schema.decodeUnknownEffect(EnabledState)(
      Struct.pick(next, enabledFields),
    );
    const skills = new Set(nextCatalogue.skills.map((skill) => skill.skill_id));
    const collections = new Set(
      nextCatalogue.collections.map((collection) => collection.collection_id),
    );
    const missing = missingEnabledSubject(nextEnabled, skills, collections);
    if (missing) return yield* new InvalidLibraryState({ path, reason: missing });
    const currentEnabled = yield* loadEnabledRows();
    const currentSelections = yield* Schema.decodeUnknownEffect(EnabledState)(
      Struct.pick(currentEnabled, enabledFields),
    );
    const currentInstalled = yield* loadInstalledSkillRows(path);
    if (
      canonicalJson(currentCatalogue) !== canonicalJson(beforeCatalogue) ||
      canonicalJson(currentSelections) !== canonicalJson(beforeEnabled) ||
      canonicalJson(currentInstalled) !== canonicalJson(base.installed_skills)
    )
      return yield* new LibraryChanged({ path });
    const catalogueChanged = canonicalJson(nextCatalogue) !== canonicalJson(beforeCatalogue);
    const enabledChanged = canonicalJson(nextEnabled) !== canonicalJson(beforeEnabled);
    const installedChanged =
      canonicalJson(next.installed_skills) !== canonicalJson(currentInstalled);
    if (!catalogueChanged && !enabledChanged && !installedChanged) return;
    if (catalogueChanged) {
      yield* checkCatalogueChange(path, nextDocument, beforeDocument);
      yield* saveCatalogueBase(path, nextDocument, beforeDocument);
      yield* saveCatalogueRows(nextDocument, beforeDocument);
    }
    if (enabledChanged) yield* saveEnabledRows(currentEnabled, nextDocument);
    if (installedChanged) {
      const installed = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.declare(Schema.is(InstalledSkill))),
      )(next.installed_skills);
      yield* saveInstalledSkillRows(installed, currentInstalled);
    }
    yield* saveSetupIntentProgress(path, setupIntent(base), setupIntent(next));
    yield* advanceLibraryRevision(path);
  },
  (effect, path) =>
    effect.pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
);
