import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { AuthorHistoryInvalid, AuthorHistoryFailure } from "../src/author/history-failures.js";
import { StoreCorrupt, StoreError } from "../src/history/history.js";
import { SkitContractError } from "../src/api/contracts.js";
import { StepError } from "../src/library/store/state-schema.js";
import { Hash } from "../src/shared/hash.js";

it.effect("retains native and schema errors until the stored-step JSON boundary", () =>
  Effect.gen(function* () {
    const native = new Error("SQLite read failed", { cause: new Error("disk error") });
    const history = new AuthorHistoryInvalid({
      path: "/state/history/journal.sqlite",
      reason: { _tag: "JournalFailure", cause: native },
    });
    expect(history.reason._tag === "JournalFailure" && history.reason.cause).toBe(native);
    expect(Object.hasOwn(history, "remediation")).toBe(false);
    const schemaError = yield* Effect.flip(
      Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Int }))({ count: "bad" }),
    );
    const contract = new SkitContractError({
      contract: "history record",
      reason: { _tag: "InvalidData", failure: schemaError },
    });
    expect(contract.reason._tag === "InvalidData" && contract.reason.failure).toBe(schemaError);
    for (const failure of [history, contract]) {
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(StepError))(failure);
      const decoded = yield* Schema.decodeUnknownEffect(StepError)(
        JSON.parse(JSON.stringify(encoded)),
      );
      expect(decoded._tag).toBe(failure._tag);
      expect("reason" in decoded).toBe(true);
      if (
        Schema.is(AuthorHistoryFailure)(decoded) &&
        decoded._tag === "AuthorHistoryInvalid" &&
        decoded.reason._tag === "JournalFailure"
      ) {
        expect(decoded.reason.cause).toBeInstanceOf(Error);
        expect((decoded.reason.cause as Error).message).toBe("SQLite read failed");
        expect((decoded.reason.cause as Error).cause).toBeInstanceOf(Error);
      }
      if (Schema.is(SkitContractError)(decoded) && decoded.reason._tag === "InvalidData") {
        expect(decoded.reason.failure._tag).toBe("StoredSchemaFailure");
        if (decoded.reason.failure._tag === "StoredSchemaFailure")
          expect(decoded.reason.failure.issues[0]?.path).toEqual(["count"]);
      }
    }
  }),
);

it.effect("stores exact content mismatch facts rather than a formatted error sentence", () =>
  Effect.gen(function* () {
    const expected = Hash.make(`sha256:${"a".repeat(64)}`);
    const actual = Hash.make(`sha256:${"b".repeat(64)}`);
    const failure = new StoreCorrupt({
      kind: "tree",
      hash: expected,
      reason: { _tag: "ContentHashMismatch", actual },
    });
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(StoreError))(failure);
    expect(encoded).toEqual({
      _tag: "History.StoreCorrupt",
      kind: "tree",
      hash: expected,
      reason: { _tag: "ContentHashMismatch", actual },
    });
  }),
);
