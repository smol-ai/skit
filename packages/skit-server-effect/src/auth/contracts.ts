import { Schema } from "effect";
import { Scope } from "@smolai/skit-core/universal/api";

export { CreatedPat, ListedPat, Scope } from "@smolai/skit-core/universal/api";

export const CreatePatInput = Schema.Struct({
  name: Schema.String,
  scopes: Schema.Array(Scope),
  expiresAt: Schema.optionalKey(Schema.String),
});
export interface CreatePatInput extends Schema.Schema.Type<typeof CreatePatInput> {}
