import { Effect, Match as M, Schema as S } from "effect";
import { type Command, Runtime, Subscription } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { input } from "./components/ui/input.js";

export const Model = S.Struct({
  page: S.Literals(["home", "setup"]),
  origin: S.String,
  github: S.Boolean,
  emailEnabled: S.Boolean,
  registrationEnabled: S.Boolean,
  signedIn: S.Boolean,
  username: S.String,
  suggestedUsername: S.String,
  claimUsername: S.String,
  signInEmail: S.String,
  signInPassword: S.String,
  signUpUsername: S.String,
  signUpEmail: S.String,
  signUpPassword: S.String,
  authMode: S.Literals(["sign-in", "sign-up"]),
  setupNeeded: S.Boolean,
  bootstrapToken: S.String,
  setupUsername: S.String,
  setupEmail: S.String,
  setupPassword: S.String,
  pending: S.Boolean,
  message: S.String,
});
export type Model = typeof Model.Type;

export const Flags = S.Struct({
  page: S.Literals(["home", "setup"]),
  origin: S.String,
  github: S.Boolean,
  emailEnabled: S.Boolean,
  registrationEnabled: S.Boolean,
  signedIn: S.Boolean,
  username: S.String,
  suggestedUsername: S.String,
  setupNeeded: S.Boolean,
});
export type Flags = typeof Flags.Type;

export const Message = defineMessageUnion({
  ClientStarted: { bootstrapToken: S.String },
  ClaimUsernameChanged: { value: S.String },
  SignInEmailChanged: { value: S.String },
  SignInPasswordChanged: { value: S.String },
  SignUpUsernameChanged: { value: S.String },
  SignUpEmailChanged: { value: S.String },
  SignUpPasswordChanged: { value: S.String },
  AuthModeChanged: { mode: S.Literals(["sign-in", "sign-up"]) },
  SetupTokenChanged: { value: S.String },
  SetupUsernameChanged: { value: S.String },
  SetupEmailChanged: { value: S.String },
  SetupPasswordChanged: { value: S.String },
  GitHubSignIn: {},
  EmailSignIn: {},
  EmailSignUp: {},
  ResendVerification: {},
  ClaimUsername: {},
  SubmitSetup: {},
  ActionFinished: {
    action: S.Literals(["email", "signup", "verification", "github", "claim", "setup"]),
    ok: S.Boolean,
    message: S.String,
    redirect: S.String,
  },
  NavigationFinished: {},
});
export type Message = typeof Message.Type;

const request = <A>(
  url: string,
  schema: S.Codec<A, unknown, never, never>,
  init?: RequestInit,
): Effect.Effect<A, string> =>
  Effect.callback<A, string>((resume, signal) => {
    fetch(url, { ...init, signal })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error =
            typeof body === "object" && body !== null
              ? "code" in body
                ? String(body.code)
                : "error" in body
                  ? String(body.error)
                  : "message" in body
                    ? String(body.message)
                    : `HTTP ${response.status}`
              : `HTTP ${response.status}`;
          resume(Effect.fail(error));
          return;
        }
        S.decodeUnknownPromise(schema)(body).then(
          (value) => resume(Effect.succeed(value)),
          (cause) => resume(Effect.fail(String(cause))),
        );
      })
      .catch((cause) => resume(Effect.fail(String(cause))));
  });

const jsonRequest = <A>(url: string, schema: S.Codec<A, unknown, never, never>, body: unknown) =>
  request(url, schema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const clientStarted: Command.Command<Message> = {
  name: "client-started",
  effect: Effect.sync(() => {
    const bootstrapToken = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
    if (bootstrapToken) history.replaceState(null, "", location.pathname + location.search);
    return Message.ClientStarted({ bootstrapToken });
  }),
};

const navigate = (destination: string): Command.Command<Message> => ({
  name: "navigate",
  effect: Effect.sync(() => {
    if (destination === "reload") location.reload();
    else location.href = destination;
    return Message.NavigationFinished();
  }),
});

const finish = (
  action: "email" | "signup" | "verification" | "github" | "claim" | "setup",
  effect: Effect.Effect<string, string>,
) => ({
  name: action,
  effect: effect.pipe(
    Effect.match({
      onFailure: (message) => Message.ActionFinished({ action, ok: false, message, redirect: "" }),
      onSuccess: (redirect) => Message.ActionFinished({ action, ok: true, message: "", redirect }),
    }),
  ),
});

type Update = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message>> }>;

export const update = (model: Model, message: Message): Update =>
  M.value(message).pipe(
    M.withReturnType<Update>(),
    M.tagsExhaustive({
      ClientStarted: ({ bootstrapToken }) => ({
        model: { ...model, bootstrapToken },
      }),
      ClaimUsernameChanged: ({ value }) => ({ model: { ...model, claimUsername: value } }),
      SignInEmailChanged: ({ value }) => ({ model: { ...model, signInEmail: value } }),
      SignInPasswordChanged: ({ value }) => ({ model: { ...model, signInPassword: value } }),
      SignUpUsernameChanged: ({ value }) => ({ model: { ...model, signUpUsername: value } }),
      SignUpEmailChanged: ({ value }) => ({ model: { ...model, signUpEmail: value } }),
      SignUpPasswordChanged: ({ value }) => ({ model: { ...model, signUpPassword: value } }),
      AuthModeChanged: ({ mode }) => ({ model: { ...model, authMode: mode, message: "" } }),
      SetupTokenChanged: ({ value }) => ({ model: { ...model, bootstrapToken: value } }),
      SetupUsernameChanged: ({ value }) => ({ model: { ...model, setupUsername: value } }),
      SetupEmailChanged: ({ value }) => ({ model: { ...model, setupEmail: value } }),
      SetupPasswordChanged: ({ value }) => ({ model: { ...model, setupPassword: value } }),
      GitHubSignIn: () => ({
        model: { ...model, pending: true, message: "" },
        commands: [
          finish(
            "github",
            jsonRequest("/api/auth/sign-in/social", S.Struct({ url: S.String }), {
              provider: "github",
              callbackURL: model.origin,
            }).pipe(Effect.map(({ url }) => url)),
          ),
        ],
      }),
      EmailSignIn: () => ({
        model: { ...model, pending: true, message: "" },
        commands: [
          finish(
            "email",
            jsonRequest("/api/auth/sign-in/email", S.Unknown, {
              email: model.signInEmail,
              password: model.signInPassword,
            }).pipe(Effect.as("reload")),
          ),
        ],
      }),
      EmailSignUp: () => ({
        model: { ...model, pending: true, message: "" },
        commands: [
          finish(
            "signup",
            jsonRequest("/api/auth/sign-up/email", S.Unknown, {
              name: model.emailEnabled ? model.signUpEmail : model.signUpUsername,
              ...(model.emailEnabled ? {} : { username: model.signUpUsername }),
              email: model.signUpEmail,
              password: model.signUpPassword,
            }).pipe(Effect.as(model.emailEnabled ? "" : "reload")),
          ),
        ],
      }),
      ResendVerification: () => ({
        model: { ...model, pending: true, message: "" },
        commands: [
          finish(
            "verification",
            jsonRequest("/api/auth/send-verification-email", S.Unknown, {
              email: model.signInEmail,
              callbackURL: model.origin,
            }).pipe(Effect.as("")),
          ),
        ],
      }),
      ClaimUsername: () => ({
        model: { ...model, pending: true, message: "" },
        commands: [
          finish(
            "claim",
            jsonRequest("/api/onboarding/username", S.Unknown, {
              username: model.claimUsername,
            }).pipe(Effect.as("reload")),
          ),
        ],
      }),
      SubmitSetup: () => ({
        model: { ...model, pending: true, message: "" },
        commands: [
          {
            name: "setup",
            effect: jsonRequest("/api/bootstrap", S.Struct({ verificationEmailSent: S.Boolean }), {
              token: model.bootstrapToken,
              username: model.setupUsername,
              email: model.setupEmail,
              password: model.setupPassword,
            }).pipe(
              Effect.match({
                onFailure: (message) =>
                  Message.ActionFinished({ action: "setup", ok: false, message, redirect: "" }),
                onSuccess: ({ verificationEmailSent }) =>
                  Message.ActionFinished({
                    action: "setup",
                    ok: true,
                    message: verificationEmailSent ? "verification_sent" : "verification_not_sent",
                    redirect: "",
                  }),
              }),
            ),
          },
        ],
      }),
      ActionFinished: ({ action, ok, message, redirect }) => {
        if (ok && redirect)
          return { model: { ...model, pending: false }, commands: [navigate(redirect)] };
        if (ok && action === "setup")
          return {
            model: {
              ...model,
              pending: false,
              setupNeeded: false,
              message: model.emailEnabled
                ? message === "verification_sent"
                  ? "Setup complete. Check your email to verify the operator account."
                  : "Setup complete, but verification email was not sent. Use Resend on the sign-in page."
                : "Setup complete. This Registry is ready.",
            },
          };
        if (ok && action === "signup")
          return {
            model: {
              ...model,
              pending: false,
              message: "Check your email to verify your account, then sign in.",
            },
          };
        if (ok && action === "verification")
          return {
            model: { ...model, pending: false, message: "Verification email sent." },
          };
        const messages: Record<string, string> = {
          username_unavailable: "That username is already claimed.",
          unauthorized: "The bootstrap secret is incorrect.",
          forbidden_origin: "Setup must be completed from this Registry origin.",
          bootstrap_complete: "This Registry has already been set up.",
          rate_limited: "Too many attempts. Wait one minute and try again.",
          invalid_request: "Check the form values and try again.",
          INVALID_EMAIL_OR_PASSWORD: "Email or password is incorrect.",
          EMAIL_NOT_VERIFIED: "Verify your email before signing in.",
          INVALID_EMAIL: "Enter a valid email address.",
          USER_ALREADY_EXISTS: "An account already exists for that email.",
          INVALID_USERNAME: "Choose a username using letters, numbers, and hyphens.",
        };
        return {
          model: { ...model, pending: false, message: messages[message] ?? "The request failed." },
        };
      },
      NavigationFinished: () => ({ model }),
    }),
  );

export const subscriptions = Subscription.make<Model, Message>()(() => ({}));

export const init: Runtime.ApplicationInit<Model, Message, Flags> = (flags) => {
  const model: Model = {
    ...flags,
    claimUsername: flags.suggestedUsername,
    signInEmail: "",
    signInPassword: "",
    signUpUsername: "",
    signUpEmail: "",
    signUpPassword: "",
    authMode: "sign-in",
    bootstrapToken: "",
    setupUsername: "",
    setupEmail: "",
    setupPassword: "",
    pending: false,
    message: "",
  };
  return { model, commands: [clientStarted] };
};

const messageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.message
    ? h.p([h.Class("text-sm text-destructive"), h.Role("alert")], [model.message])
    : h.empty;

const card = (title: string, description: string, body: Html, h: HtmlBuilder<Message>): Html =>
  Card<Message>(
    { className: "w-full max-w-md" },
    [
      Card.header<Message>(
        {},
        [Card.title<Message>({}, [title], h), Card.description<Message>({}, [description], h)],
        h,
      ),
      Card.content<Message>({}, [body], h),
    ],
    h,
  );

const field = (
  label: string,
  id: string,
  value: string,
  onInput: (value: string) => Message,
  h: HtmlBuilder<Message>,
  options: { type?: string; autocomplete?: string; minlength?: number; placeholder?: string } = {},
): Html =>
  input<Message>(
    {
      id,
      name: id,
      label,
      type: options.type ?? "text",
      value,
      onInput,
      placeholder: options.placeholder ?? "",
      attributes: [
        h.Autocomplete(options.autocomplete ?? "off"),
        h.Minlength(options.minlength ?? 1),
        h.Maxlength(options.type === "password" ? 128 : 64),
        h.Required(true),
      ],
    },
    h,
  );

const setupView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (!model.setupNeeded)
    return card(
      "Set up SKIT Server",
      "Create the first server operator.",
      h.p(
        [h.Class("text-sm text-muted-foreground")],
        [model.message || "This Registry has already been set up."],
      ),
      h,
    );
  return card(
    "Set up SKIT Server",
    "Create the first server operator. This setup can only be completed once.",
    h.form(
      [h.OnSubmit(Message.SubmitSetup()), h.Class("grid gap-4")],
      [
        ...(model.bootstrapToken
          ? []
          : [
              field(
                "Bootstrap secret",
                "token",
                model.bootstrapToken,
                (value) => Message.SetupTokenChanged({ value }),
                h,
                { type: "password" },
              ),
            ]),
        field(
          "Username",
          "username",
          model.setupUsername,
          (value) => Message.SetupUsernameChanged({ value }),
          h,
          { autocomplete: "username" },
        ),
        field(
          "Email",
          "email",
          model.setupEmail,
          (value) => Message.SetupEmailChanged({ value }),
          h,
          { type: "email", autocomplete: "email" },
        ),
        field(
          "Password",
          "password",
          model.setupPassword,
          (value) => Message.SetupPasswordChanged({ value }),
          h,
          { type: "password", autocomplete: "new-password", minlength: 8 },
        ),
        messageView(model, h),
        button<Message>(
          { type: "submit", isDisabled: model.pending, className: "w-full" },
          model.pending ? "Completing setup…" : "Complete setup",
          h,
        ),
      ],
    ),
    h,
  );
};

const homeCard = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.signedIn && !model.username)
    return card(
      "Choose your SKIT username",
      "This becomes your Namespace on this Registry. Your GitHub handle is only a suggestion.",
      h.form(
        [h.OnSubmit(Message.ClaimUsername()), h.Class("grid gap-4")],
        [
          field(
            "Username",
            "username",
            model.claimUsername,
            (value) => Message.ClaimUsernameChanged({ value }),
            h,
            { autocomplete: "username" },
          ),
          messageView(model, h),
          button<Message>(
            { type: "submit", isDisabled: model.pending, className: "w-full" },
            model.pending ? "Claiming…" : "Claim username",
            h,
          ),
        ],
      ),
      h,
    );
  if (model.signedIn)
    return card(
      "You're all set",
      `Signed in as ${model.username}. Your SKIT account is ready.`,
      h.div(
        [h.Class("grid gap-4")],
        [
          h.p(
            [h.Class("text-sm leading-6 text-muted-foreground")],
            ["Connect the SKIT CLI to this Registry from your terminal:"],
          ),
          h.pre(
            [
              h.Class(
                "overflow-x-auto rounded-md border bg-muted px-4 py-3 font-mono text-sm text-foreground",
              ),
            ],
            [h.code([], [`skit auth login ${model.origin}`])],
          ),
          h.p(
            [h.Class("text-xs leading-5 text-muted-foreground")],
            ["The CLI will ask for your email and password and store a scoped credential locally."],
          ),
        ],
      ),
      h,
    );

  const signingUp = model.authMode === "sign-up";
  const credentialForm = signingUp
    ? h.form(
        [h.OnSubmit(Message.EmailSignUp()), h.Class("grid gap-4")],
        [
          ...(model.emailEnabled
            ? []
            : [
                field(
                  "Username",
                  "sign-up-username",
                  model.signUpUsername,
                  (value) => Message.SignUpUsernameChanged({ value }),
                  h,
                  { autocomplete: "username", placeholder: "your-name" },
                ),
              ]),
          field(
            "Email",
            "sign-up-email",
            model.signUpEmail,
            (value) => Message.SignUpEmailChanged({ value }),
            h,
            { type: "email", autocomplete: "email", placeholder: "m@example.com" },
          ),
          field(
            "Password",
            "sign-up-password",
            model.signUpPassword,
            (value) => Message.SignUpPasswordChanged({ value }),
            h,
            { type: "password", autocomplete: "new-password", minlength: 8 },
          ),
          messageView(model, h),
          button<Message>(
            { type: "submit", isDisabled: model.pending, className: "w-full" },
            model.pending ? "Creating account…" : "Create account",
            h,
          ),
          ...(model.emailEnabled
            ? [
                h.p(
                  [h.Class("text-center text-xs text-muted-foreground")],
                  ["We'll email you a verification link."],
                ),
              ]
            : []),
        ],
      )
    : h.form(
        [h.OnSubmit(Message.EmailSignIn()), h.Class("grid gap-4")],
        [
          field(
            "Email",
            "sign-in-email",
            model.signInEmail,
            (value) => Message.SignInEmailChanged({ value }),
            h,
            { type: "email", autocomplete: "email", placeholder: "m@example.com" },
          ),
          field(
            "Password",
            "sign-in-password",
            model.signInPassword,
            (value) => Message.SignInPasswordChanged({ value }),
            h,
            { type: "password", autocomplete: "current-password", minlength: 8 },
          ),
          messageView(model, h),
          button<Message>(
            { type: "submit", isDisabled: model.pending, className: "w-full" },
            model.pending ? "Signing in…" : "Sign in",
            h,
          ),
          ...(model.emailEnabled
            ? [
                button<Message>(
                  {
                    type: "button",
                    onClick: Message.ResendVerification(),
                    isDisabled: model.pending || !model.signInEmail,
                    variant: "ghost",
                    className: "w-full",
                  },
                  "Resend verification email",
                  h,
                ),
              ]
            : []),
        ],
      );

  return card(
    signingUp ? "Create an account" : "Welcome back",
    signingUp
      ? model.emailEnabled
        ? "Verify your email, then choose your Registry username."
        : "Choose a username and create your SKIT account."
      : "Enter your email and password to sign in.",
    h.div(
      [h.Class("grid gap-6")],
      [
        ...(model.registrationEnabled
          ? [
              h.div(
                [h.Class("grid grid-cols-2 rounded-md bg-muted p-1")],
                [
                  button<Message>(
                    {
                      type: "button",
                      onClick: Message.AuthModeChanged({ mode: "sign-in" }),
                      variant: signingUp ? "ghost" : "secondary",
                      className: "w-full",
                    },
                    "Sign in",
                    h,
                  ),
                  button<Message>(
                    {
                      type: "button",
                      onClick: Message.AuthModeChanged({ mode: "sign-up" }),
                      variant: signingUp ? "secondary" : "ghost",
                      className: "w-full",
                    },
                    "Sign up",
                    h,
                  ),
                ],
              ),
            ]
          : []),
        credentialForm,
        model.github
          ? h.div(
              [h.Class("grid gap-4")],
              [
                h.div(
                  [h.Class("relative")],
                  [
                    h.div(
                      [h.Class("absolute inset-0 flex items-center")],
                      [h.span([h.Class("w-full border-t")], [])],
                    ),
                    h.div(
                      [h.Class("relative flex justify-center text-xs uppercase")],
                      [
                        h.span(
                          [h.Class("bg-card px-2 text-muted-foreground")],
                          ["Or continue with"],
                        ),
                      ],
                    ),
                  ],
                ),
                button<Message>(
                  {
                    type: "button",
                    onClick: Message.GitHubSignIn(),
                    isDisabled: model.pending,
                    variant: "outline",
                    className: "w-full",
                  },
                  model.pending ? "Connecting…" : "GitHub",
                  h,
                ),
              ],
            )
          : h.empty,
      ],
    ),
    h,
  );
};

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.page === "setup" ? "Set up SKIT Server" : "SKIT",
  body: h.div(
    [h.Class("min-h-screen bg-background text-foreground")],
    [
      h.header(
        [h.Class("border-b bg-background/90 backdrop-blur")],
        [
          h.div(
            [h.Class("mx-auto flex h-14 max-w-6xl items-center px-5")],
            [h.a([h.Href("/"), h.Class("font-semibold tracking-tight")], ["SKIT"])],
          ),
        ],
      ),
      model.page === "setup"
        ? h.main(
            [
              h.Class(
                "flex min-h-[calc(100vh-3.5rem)] items-center justify-center bg-muted/40 px-5 py-16",
              ),
            ],
            [setupView(model, h)],
          )
        : h.main(
            [
              h.Class(
                "flex min-h-[calc(100vh-3.5rem)] items-center justify-center bg-muted/40 px-5 py-16",
              ),
            ],
            [homeCard(model, h)],
          ),
    ],
  ),
});
