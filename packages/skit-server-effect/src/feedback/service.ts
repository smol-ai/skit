import { D1Client } from "@effect/sql-d1";
import { Clock, Context, Effect, Layer } from "effect";
import type { FeedbackInput, FeedbackResult } from "@smolai/skit-core/universal/api";
import {
  databaseError,
  type DatabaseError,
  type DatabaseSqlClient,
} from "../platform/cloudflare.js";
import { NativeCrypto } from "../platform/native-crypto.js";

export interface FeedbackService {
  /** Store one report. `client` is the sender's `skit-client` header, when it sent one. */
  readonly record: (
    input: FeedbackInput & { readonly client: string | undefined },
  ) => Effect.Effect<FeedbackResult, DatabaseError>;
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

    const record = Effect.fn("Feedback.record")(function* (
      input: FeedbackInput & { readonly client: string | undefined },
    ) {
      const id = `feedback_${crypto.randomUUID().replaceAll("-", "")}`;
      const createdAt = new Date(yield* clock.currentTimeMillis).toISOString();
      yield* sql`INSERT INTO feedback
          (id, message, harness, model, platform, runtime, client, created_at)
        VALUES (${id}, ${input.message}, ${input.harness ?? null}, ${input.model ?? null},
          ${input.platform}, ${input.runtime}, ${input.client ?? null}, ${createdAt})`.pipe(
        databaseError("record feedback"),
      );
      return { id, createdAt };
    });

    return { record };
  }),
);
