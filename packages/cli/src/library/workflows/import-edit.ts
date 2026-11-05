import { SkitConfiguration } from "@smolai/skit-core";
import { openEditImport } from "@smolai/skit-core/library/session";
import { Effect } from "effect";
export { EditImportMissing, EditImportAmbiguous } from "@smolai/skit-core/library/session";

export const prepareEditImport = Effect.fn("CLI.prepareEditImport")(function* (
  query: string,
  selector: string,
) {
  const paths = yield* SkitConfiguration;
  const prepared = yield* openEditImport(paths.skitHome, query, selector);
  return {
    preview: prepared.preview,
    apply: () => Effect.flatMap(SkitConfiguration, (current) => prepared.apply(current.skitHome)),
  };
});
