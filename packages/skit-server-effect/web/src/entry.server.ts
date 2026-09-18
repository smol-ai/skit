import { Effect, Schema as S } from "effect";
import { Server } from "foldkit/experimental";
import { Flags, init, view } from "./main.js";

const UiConfiguration = S.Struct({
  github: S.Boolean,
  email: S.Boolean,
  registration: S.Boolean,
});
const Session = S.NullOr(
  S.Struct({
    user: S.optional(S.Struct({ username: S.NullOr(S.String), name: S.NullOr(S.String) })),
  }),
);
const BootstrapStatus = S.Struct({ needed: S.Boolean });

type RequestHandler = (request: Request) => Promise<Response>;

const requestJson = <A>(
  handler: RequestHandler,
  request: Request,
  schema: S.Codec<A, unknown, never, never>,
): Effect.Effect<A, Error> =>
  Effect.callback<A, Error>((resume, signal) => {
    handler(new Request(request, { signal }))
      .then(async (response) => {
        if (!response.ok) {
          resume(Effect.fail(new Error(`HTTP ${response.status} from ${request.url}`)));
          return;
        }
        const body: unknown = await response.json();
        S.decodeUnknownPromise(schema)(body).then(
          (value) => resume(Effect.succeed(value)),
          (cause) => resume(Effect.fail(new Error(String(cause)))),
        );
      })
      .catch((cause) => resume(Effect.fail(new Error(String(cause)))));
  });

const requestFor = (request: Request, pathname: string): Request => {
  const url = new URL(pathname, request.url);
  return new Request(url, { headers: request.headers });
};

const flagsForRequest = (request: Request, handler: RequestHandler): Effect.Effect<Flags, Error> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const page = url.pathname === "/setup" ? "setup" : "home";
    const [configuration, session] = yield* Effect.all([
      requestJson(handler, requestFor(request, "/api/ui/config"), UiConfiguration),
      requestJson(handler, requestFor(request, "/api/auth/get-session"), Session).pipe(
        Effect.catch(() => Effect.succeed(null)),
      ),
    ]);
    const setupNeeded =
      page === "setup"
        ? yield* requestJson(
            handler,
            requestFor(request, "/api/bootstrap/status"),
            BootstrapStatus,
          ).pipe(
            Effect.map(({ needed }) => needed),
            Effect.catch(() => Effect.succeed(false)),
          )
        : false;
    const user = session?.user;
    return {
      page,
      origin: url.origin,
      github: configuration.github,
      emailEnabled: configuration.email,
      registrationEnabled: configuration.registration,
      signedIn: user !== undefined,
      username: user?.username ?? "",
      suggestedUsername: user?.name ?? "",
      setupNeeded,
    };
  });

export const renderPage = (
  request: Request,
  handler: RequestHandler = fetch,
  buildId = (import.meta as ImportMeta & { readonly env: ImportMetaEnv }).env.FOLDKIT_BUILD_ID,
): Promise<Server.EntryResult> =>
  // oxlint-disable-next-line skit/no-nested-runtime -- Foldkit's server entry is the runtime boundary and its Vite host requires a Promise-returning renderPage export.
  Effect.runPromise(renderPageEffect(request, handler, buildId));

export const renderPageEffect = (
  request: Request,
  handler: RequestHandler,
  buildId: string,
): Effect.Effect<Server.EntryResult, Error | Server.RenderError> =>
  Effect.gen(function* () {
    const flags = yield* flagsForRequest(request, handler);
    const renderedApplication = yield* Server.renderToString(
      { Flags, init, view },
      { flags, buildId },
    );
    return Server.Rendered(renderedApplication, {
      headers: {
        "cache-control": "private, no-store",
        vary: "cookie",
        "x-content-type-options": "nosniff",
      },
    });
  });
