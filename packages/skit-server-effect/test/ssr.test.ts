import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { Server } from "foldkit/experimental";
import { renderPageEffect } from "../web/src/entry.server.js";
import { Flags, init, Message, update, view } from "../web/src/main.js";

const template = `<!doctype html><html><head><title>SKIT</title></head><body><div id="root"></div><script type="module" src="/src/entry.ts"></script></body></html>`;

const handler = (request: Request): Promise<Response> => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/ui/config")
    return Promise.resolve(Response.json({ github: true, email: true, registration: true }));
  if (pathname === "/api/auth/get-session")
    return Promise.resolve(Response.json({ user: { username: "tim", name: "Tim" }, session: {} }));
  if (pathname === "/api/bootstrap/status") return Promise.resolve(Response.json({ needed: true }));
  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
};

const signedOutHandler = (request: Request): Promise<Response> => {
  if (new URL(request.url).pathname === "/api/auth/get-session")
    return Promise.resolve(Response.json(null));
  return handler(request);
};

const unclaimedHandler = (request: Request): Promise<Response> => {
  if (new URL(request.url).pathname === "/api/auth/get-session")
    return Promise.resolve(
      Response.json({ user: { username: null, name: "Suggested Name" }, session: {} }),
    );
  return handler(request);
};

describe("Foldkit server rendering", () => {
  it.effect("renders authenticated Registry state into the initial HTML", () =>
    Effect.gen(function* () {
      const result = yield* renderPageEffect(
        new Request("https://registry.example/"),
        handler,
        "test",
      );
      const response = Server.toResponse(template, result);
      const html = yield* responseText(response);

      expect(response.status).toBe(200);
      expect(html).toContain("You're all set");
      expect(html).toContain("skit auth login https://registry.example");
      expect(html).toContain('data-foldkit-build="test"');
      expect(html).not.toContain("Loading Registry");
    }),
  );

  it.effect("renders setup state before the client hydrates", () =>
    Effect.gen(function* () {
      const result = yield* renderPageEffect(
        new Request("https://registry.example/setup"),
        handler,
        "test",
      );
      const html = yield* responseText(Server.toResponse(template, result));

      expect(html).toContain("Create the first server operator");
      expect(html).toContain("Complete setup");
      expect(html).toContain("Show password");
      expect(html).toContain("Show bootstrap secret");
      expect(html).not.toContain("Your library. Your rules.");
    }),
  );

  it.effect("renders email and GitHub sign-in before the client hydrates", () =>
    Effect.gen(function* () {
      const result = yield* renderPageEffect(
        new Request("https://registry.example/"),
        signedOutHandler,
        "test",
      );
      const html = yield* responseText(Server.toResponse(template, result));

      expect(html).toContain("Welcome back");
      expect(html).toContain('name="sign-in-email"');
      expect(html).toContain('name="sign-in-password"');
      expect(html).toContain("Show password");
      expect(html).toContain("Sign up");
      expect(html).toContain("Or continue with");
      expect(html).toContain("GitHub");
      expect(html).toContain("Your library. Your rules.");
      expect(html).toContain('href="https://github.com/smol-ai/skit"');
      expect(html).toContain(
        'href="https://github.com/smol-ai/skit/blob/main/docs/self-hosting.md"',
      );
      expect(html).toContain('id="sign-in"');
      expect(html).toContain("skit sync --apply");
      expect(html).not.toContain("skit library sync");
    }),
  );

  it.effect("guides signed-out users after setup, including when the page is reloaded", () =>
    Effect.gen(function* () {
      const result = yield* renderPageEffect(
        new Request("https://registry.example/setup"),
        (request) =>
          new URL(request.url).pathname === "/api/bootstrap/status"
            ? Promise.resolve(Response.json({ needed: false }))
            : signedOutHandler(request),
        "test",
      );
      const html = yield* responseText(Server.toResponse(template, result));
      expect(html).toContain("Your Registry is ready");
      expect(html).toContain("does not sign you in");
      expect(html).toContain("Sign in to your account");
      expect(html).toContain("Verify your email before signing in");
      expect(html).toContain("skit auth login https://registry.example");
      expect(html).toContain("skit sync --apply");
      expect(html).toContain("preview the changes");
      expect(html).not.toContain("skit library sync");
      expect(html).not.toContain("Complete setup");
    }),
  );

  it.effect("clears setup secrets and offers an immediate sign-in step after success", () =>
    Effect.gen(function* () {
      const flags: Flags = {
        page: "setup",
        origin: "https://registry.example",
        github: false,
        emailEnabled: false,
        registrationEnabled: true,
        signedIn: false,
        username: "",
        suggestedUsername: "",
        setupNeeded: true,
      };
      const initial = init(flags).model;
      const completed = update(
        { ...initial, setupPassword: "private-password", bootstrapToken: "private-token" },
        Message.ActionFinished({
          action: "setup",
          ok: true,
          message: "verification_not_sent",
          redirect: "",
        }),
      ).model;
      expect(completed.setupPassword).toBe("");
      expect(completed.bootstrapToken).toBe("");
      const rendered = yield* Server.renderToString(
        { Flags, init: () => ({ model: completed }), view },
        { flags, buildId: "test" },
      );
      const html = yield* responseText(Server.toResponse(template, Server.Rendered(rendered)));
      expect(html).toContain("Sign in to your account");
      expect(html).toContain("Your operator account has been created");
      expect(html).not.toContain("Verify your email before signing in");
      expect(html).not.toContain("private-password");
      expect(html).not.toContain("private-token");
    }),
  );

  it.effect("renders username claim for a verified account without a Registry identity", () =>
    Effect.gen(function* () {
      const result = yield* renderPageEffect(
        new Request("https://registry.example/"),
        unclaimedHandler,
        "test",
      );
      const html = yield* responseText(Server.toResponse(template, result));

      expect(html).toContain("Choose your SKIT username");
      expect(html).toContain('name="username"');
      expect(html).not.toContain("You're all set");
    }),
  );
});

const responseText = (response: Response): Effect.Effect<string, Error> =>
  Effect.callback((resume) => {
    response.text().then(
      (text) => resume(Effect.succeed(text)),
      (cause) => resume(Effect.fail(new Error(String(cause)))),
    );
  });
