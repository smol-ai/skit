import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { Server } from "foldkit/experimental";
import { renderPageEffect } from "../web/src/entry.server.js";

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
      expect(html).toContain("Sign up");
      expect(html).toContain("Or continue with");
      expect(html).toContain("GitHub");
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
