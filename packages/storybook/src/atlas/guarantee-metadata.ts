import { Schema } from "effect";

const label = Schema.NonEmptyString.check(Schema.isTrimmed());
export const Guarantee = Schema.Struct({
  key: label,
  command: label,
  section: label,
  sectionOrder: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  title: label,
});
export type Guarantee = typeof Guarantee.Type;

export function guaranteeAncestry(ancestorTitles: readonly string[], guarantee?: Guarantee) {
  return guarantee === undefined
    ? { ancestorTitles }
    : {
        ancestorTitles: [`skit ${guarantee.command}`, guarantee.section, guarantee.title],
        guarantee,
      };
}
