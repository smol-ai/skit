import { D1Client } from "@effect/sql-d1";
import { Clock, Context, Effect, Layer } from "effect";
import type { FeedbackInput, FeedbackResult } from "@smolai/skit-core/universal/api";
import {
  databaseError,
  type DatabaseError,
  type DatabaseSqlClient,
} from "../platform/cloudflare.js";
import { NativeCrypto } from "../platform/native-crypto.js";

/**
 * One report as stored. `client` is the sender's `skit-client` header, when it sent one;
 * `principalId` is the account that signed it, when the sender chose to.
 */
export type FeedbackRecord = FeedbackInput & {
  readonly client: string | undefined;
  readonly principalId: string | undefined;
};

export interface FeedbackService {
  readonly record: (input: FeedbackRecord) => Effect.Effect<FeedbackResult, DatabaseError>;
}

export class Feedback extends Context.Service<Feedback, FeedbackService>()(
  "@skit-server-effect/Feedback",
) {}

export const layer = Layer.effect(
  Feedback,
  Effect.gen(function* () {
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const crypto = yield* NativeCrypto;
    const clock = yield* Clock.Clock;

    const record = Effect.fn("Feedback.record")(function* (input: FeedbackRecord) {
      const id = `feedback_${crypto.randomUUID().replaceAll("-", "")}`;
      const createdAt = new Date(yield* clock.currentTimeMillis).toISOString();
      yield* sql`INSERT INTO feedback
          (id, message, harness, model, platform, runtime, client, principal_id, contact_email,
            created_at)
        VALUES (${id}, ${input.message}, ${input.harness ?? null}, ${input.model ?? null},
          ${input.platform}, ${input.runtime}, ${input.client ?? null},
          ${input.principalId ?? null}, ${input.email ?? null}, ${createdAt})`.pipe(
        databaseError("record feedback"),
      );
      return { id, createdAt };
    });

    return { record };
  }),
);
