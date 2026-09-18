import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { schemaBodyJsonLimited } from "../src/api/request-body.js";

const Payload = Schema.Struct({ value: Schema.String });

describe("bounded request bodies", () => {
  it.effect("decodes JSON below the byte limit", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request("https://registry.test/test", {
          method: "POST",
          body: JSON.stringify({ value: "ok" }),
        }),
      );

      expect(yield* schemaBodyJsonLimited(request, Payload, 32)).toEqual({ value: "ok" });
    }),
  );

  it.effect("stops an unlabelled body stream at the byte limit", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request("https://registry.test/test", {
          method: "POST",
          body: JSON.stringify({ value: "too large" }),
        }),
      );
      const result = yield* Effect.result(schemaBodyJsonLimited(request, Payload, 8));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toBe("Http.RequestBodyTooLarge");
    }),
  );
});
