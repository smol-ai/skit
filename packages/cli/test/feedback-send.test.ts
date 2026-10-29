import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { join } from "node:path";
import { ConfigProvider, Effect, FileSystem } from "effect";
import { HttpClientError } from "effect/http";
import {
  feedbackInput,
  feedbackOrigin,
  feedbackSigningToken,
  sendFeedback,
} from "../src/feedback/send.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";
import { scratch } from "./helpers/library-home.js";
import { testPlatformLayer } from "./helpers/platform.js";

const send = (handler: TestHttpHandler, token?: string) =>
  Effect.scoped(
    sendFeedback(
      "https://feedback.test",
      {
        message: "setup --json had no field for skipped skills",
        harness: "codex",
        platform: "darwin",
        runtime: "v24.10.1",
      },
      token,
    ).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(handler)))),
  );

const created = () =>
  Effect.succeed(
    Response.json({ id: "feedback_1", createdAt: "2026-10-29T09:00:00.000Z" }, { status: 201 }),
  );

const withEnvironment = (environment: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment)));

describe("feedback input", () => {
  it.effect(
    "takes the message from the argument or --message, with this platform and runtime",
    () =>
      Effect.gen(function* () {
        const fromArgument = yield* feedbackInput({
          text: "  unclear error  ",
          message: undefined,
          harness: "claude-code",
          model: undefined,
          email: undefined,
        });
        const fromFlag = yield* feedbackInput({
          text: undefined,
          message: "unclear error",
          harness: undefined,
          model: " ",
          email: " ada@example.com ",
        });

        expect(fromArgument).toEqual({
          message: "unclear error",
          harness: "claude-code",
          platform: process.platform,
          runtime: process.version,
        });
        expect(fromFlag).toEqual({
          message: "unclear error",
          email: "ada@example.com",
          platform: process.platform,
          runtime: process.version,
        });
      }),
  );

  it.effect("refuses a missing message, two messages, an oversized one, and a bad address", () =>
    Effect.gen(function* () {
      const refused = (options: Parameters<typeof feedbackInput>[0]) =>
        Effect.flip(feedbackInput(options)).pipe(Effect.map((error) => error._tag));
      const none = {
        text: undefined,
        message: undefined,
        harness: undefined,
        model: undefined,
        email: undefined,
      };

      expect(yield* refused(none)).toBe("FeedbackInputInvalid");
      expect(yield* refused({ ...none, text: "a", message: "b" })).toBe("FeedbackInputInvalid");
      expect(yield* refused({ ...none, text: "x".repeat(10_001) })).toBe("FeedbackInputInvalid");
      expect(yield* refused({ ...none, text: "ok", harness: "h".repeat(201) })).toBe(
        "FeedbackInputInvalid",
      );
      expect(yield* refused({ ...none, text: "ok", email: "ada" })).toBe("FeedbackInputInvalid");
    }),
  );
});

describe("feedback origin", () => {
  it.effect("goes to the hosted SKIT server whatever Registry is configured", () =>
    feedbackOrigin.pipe(
      Effect.map((origin) => expect(origin).toBe("https://skit.smol.ai")),
      withEnvironment({ SKIT_SERVER_URL: "https://self-hosted.example" }),
    ),
  );

  it.effect("goes to SKIT_FEEDBACK_URL when it is set", () =>
    feedbackOrigin.pipe(
      Effect.map((origin) => expect(origin).toBe("http://localhost:8787")),
      withEnvironment({ SKIT_FEEDBACK_URL: "http://localhost:8787/ignored/path" }),
    ),
  );
});

describe("signing feedback", () => {
  const writeCredentials = (home: string, servers: Record<string, unknown>) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.writeFileString(join(home, "auth.json"), JSON.stringify({ schemaVersion: 1, servers })),
    );
  const credential = (token: string) => ({
    token,
    tokenId: "token-id",
    tokenPrefix: token,
    scopes: [],
  });

  it.effect("signs with this machine's credential for the feedback server and no other", () =>
    Effect.gen(function* () {
      const home = yield* scratch("skit-feedback-signing-");
      yield* writeCredentials(home, {
        "https://self-hosted.example": credential("skit_pat_self_hosted"),
        "https://skit.smol.ai": credential("skit_pat_hosted"),
      });

      expect(yield* feedbackSigningToken("https://skit.smol.ai", home)).toBe("skit_pat_hosted");
    }).pipe(Effect.provide(testPlatformLayer)),
  );

  it.effect("asks for sign-in when this machine has no credential for the feedback server", () =>
    Effect.gen(function* () {
      const home = yield* scratch("skit-feedback-unsigned-");
      yield* writeCredentials(home, {
        "https://self-hosted.example": credential("skit_pat_self_hosted"),
      });

      const error = yield* Effect.flip(feedbackSigningToken("https://skit.smol.ai", home));

      expect(error).toMatchObject({
        _tag: "FeedbackSignInRequired",
        remediation: expect.stringContaining("skit auth login"),
      });
    }).pipe(Effect.provide(testPlatformLayer)),
  );
});

describe("sending feedback", () => {
  it.effect("sends a signing token as a Bearer credential, and none when unsigned", () =>
    Effect.gen(function* () {
      const authorization: Array<string | undefined> = [];
      const record: TestHttpHandler = (request) =>
        Effect.sync(() => authorization.push(request.headers["authorization"])).pipe(
          Effect.andThen(created),
        );

      yield* send(record);
      yield* send(record, "skit_pat_hosted");

      expect(authorization).toEqual([undefined, "Bearer skit_pat_hosted"]);
    }),
  );

  it.effect("asks for sign-in when the server refuses the signing token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        send(
          () => Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 })),
          "skit_pat_revoked",
        ),
      );

      expect(error._tag).toBe("FeedbackSignInRequired");
    }),
  );

  it.effect("posts the report once and returns the server's result", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; url: string; body: unknown }> = [];

      const sent = yield* send((request, url) =>
        Effect.sync(() => {
          requests.push({
            method: request.method,
            url: url.href,
            body:
              request.body._tag === "Uint8Array"
                ? JSON.parse(new TextDecoder().decode(request.body.body))
                : undefined,
          });
          return Response.json(
            { id: "feedback_1", createdAt: "2026-10-29T09:00:00.000Z" },
            { status: 201 },
          );
        }),
      );

      expect(sent).toEqual({ id: "feedback_1", createdAt: "2026-10-29T09:00:00.000Z" });
      expect(requests).toEqual([
        {
          method: "POST",
          url: "https://feedback.test/api/feedback",
          body: {
            message: "setup --json had no field for skipped skills",
            harness: "codex",
            platform: "darwin",
            runtime: "v24.10.1",
          },
        },
      ]);
    }),
  );

  it.effect("reports a rate-limited send as not sent, without retrying", () =>
    Effect.gen(function* () {
      let attempts = 0;

      const error = yield* Effect.flip(
        send(() =>
          Effect.sync(() => {
            attempts += 1;
            return Response.json({ error: "rate_limited" }, { status: 429 });
          }),
        ),
      );

      expect(error._tag).toBe("FeedbackNotSent");
      expect(attempts).toBe(1);
    }),
  );

  it.effect("reports an unreachable server as not sent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        send((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "offline" }),
            }),
          ),
        ),
      );

      expect(error._tag).toBe("FeedbackNotSent");
    }),
  );
});
