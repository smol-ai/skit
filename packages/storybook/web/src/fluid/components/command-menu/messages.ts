import { Schema } from 'effect';
import { defineMessageUnion } from 'foldkit/message';
import * as Tabs from '../tabs';
export const Message = defineMessageUnion({
  QueryChanged: { query: Schema.String },
  Moved: { to: Schema.Literals(['next', 'previous', 'first', 'last']) },
  /** A pointer reached a row; reported by the runtime. */
  Hovered: { index: Schema.Number },
  Picked: { index: Schema.NullOr(Schema.Number) },
  Cleared: {},
  TabStepped: { step: Schema.Literals([1, -1]) },
  Tabs: { message: Tabs.Message },
});
export type Message = typeof Message.Type;
