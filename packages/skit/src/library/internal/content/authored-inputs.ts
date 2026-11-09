import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { containedSkillSchema, skitDescriptorSchema } from "../../../artifact/schemas.js";
import { Hash } from "../../../shared/hash.js";
import { InvalidLibraryState } from "../../failures.js";

export const authoredInputsFile = "skit.author-inputs.json";
export const AuthoredSelection = Schema.Struct({
  declaration: containedSkillSchema,
  input_hash: Hash,
  imported_at: Schema.optionalKey(Schema.String),
  source: Schema.Union([
    Schema.Struct({ revision_id: Schema.String, saved_at: Schema.optionalKey(Schema.String) }),
    Schema.Struct({ collection_hash: Hash }),
  ]),
});
export const AuthoredInputs = Schema.fromJsonString(
  Schema.Struct({
    descriptor: skitDescriptorSchema,
    selections: Schema.Array(AuthoredSelection),
  }),
);

/** Provenance belongs to this immutable retained tree, including each held member's source. */
export const readAuthoredInputs = Effect.fn("Library.readAuthoredInputs")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(root, authoredInputsFile);
  if (!(yield* fs.exists(path))) return undefined;
  return yield* Schema.decodeEffect(AuthoredInputs)(yield* fs.readFileString(path)).pipe(
    Effect.mapError((error) => new InvalidLibraryState({ path, detail: error.message })),
  );
});
