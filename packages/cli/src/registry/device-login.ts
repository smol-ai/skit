import { Clock, Duration, Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join } from "node:path";
import { DeviceLoginEnded, DeviceLoginUnavailable, SignInFailed } from "./failures.js";
import {
  authPath,
  loginEffect,
  openExchange,
  rejected,
  withConfigurationWriter,
  type AuthScope,
} from "./auth.js";

import { validateAuthenticationOrigin } from "./accounts.js";
const ok = (response: { readonly status: number }) =>
  response.status >= 200 && response.status < 300;

type Exchange = Effect.Success<ReturnType<typeof openExchange>>;
/** The only device-authorization client the Registry accepts. */
const CLI_DEVICE_CLIENT_ID = "skit-cli";
const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
});
const DeviceTokenResponse = Schema.Struct({ access_token: Schema.String });
const DeviceTokenError = Schema.Struct({ error: Schema.String });

/**
 * A browser login waiting for the user to approve its code. A run that cannot wait for the user
 * saves it, and the next `skit auth login` for the same Registry polls with it.
 */
export const PendingDeviceLogin = Schema.Struct({
  origin: Schema.String,
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUri: Schema.String,
  interval: Schema.Number,
  expiresAt: Schema.String,
});
export type PendingDeviceLogin = typeof PendingDeviceLogin.Type;

const requestDeviceCode = Effect.fn("Auth.requestDeviceCode")(function* (
  exchange: Exchange,
  origin: string,
) {
  const { discovery, send, json } = exchange;
  if (discovery.deviceAuthorization === undefined || discovery.deviceToken === undefined)
    return yield* new DeviceLoginUnavailable({ origin });
  const started = yield* send(new URL(discovery.deviceAuthorization, origin), {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_id: CLI_DEVICE_CLIENT_ID }),
  });
  if (!ok(started)) return yield* rejected(started, "Device authorization");
  const code = yield* started.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DeviceCodeResponse)),
    Effect.mapError(
      (error) => new SignInFailed({ message: `Device authorization is invalid: ${error.message}` }),
    ),
  );
  return {
    origin,
    deviceCode: code.device_code,
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    interval: code.interval,
    expiresAt: new Date((yield* Clock.currentTimeMillis) + code.expires_in * 1_000).toISOString(),
  } satisfies PendingDeviceLogin;
});

/** Where a started browser login waits for its next run: beside auth.json, as private. */
const pendingLoginPath = (home?: string) =>
  Effect.map(authPath(home), (path) => join(dirname(path), "login-pending.json"));

const readSavedPendingLogin = Effect.fn("Registry.readSavedPendingLogin")(function* (
  home?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(yield* pendingLoginPath(home))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PendingDeviceLogin))),
      Effect.option,
    );
});

/** The browser login waiting on this origin, unless expired or unreadable. */
export const readPendingLogin = Effect.fn("Registry.readPendingLogin")(function* (
  origin: string,
  home?: string,
) {
  const pending = yield* readSavedPendingLogin(home);
  if (Option.isNone(pending) || pending.value.origin !== origin) return undefined;
  return Date.parse(pending.value.expiresAt) > (yield* Clock.currentTimeMillis)
    ? pending.value
    : undefined;
});

const writePendingLogin = Effect.fn("Registry.writePendingLogin")(function* (
  pending: PendingDeviceLogin,
  home?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* pendingLoginPath(home);
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
    yield* fs.chmod(temporary, 0o600);
    yield* fs.rename(temporary, path).pipe(Effect.uninterruptible);
  }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
});

/** A completed old request may not remove a newer pending login. */
const clearPendingLogin = Effect.fn("Registry.clearPendingLogin")(function* (
  pending: PendingDeviceLogin,
  home?: string,
) {
  const current = yield* readSavedPendingLogin(home);
  if (
    Option.isNone(current) ||
    current.value.origin !== pending.origin ||
    current.value.deviceCode !== pending.deviceCode
  )
    return;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* pendingLoginPath(home), { force: true });
});

/** Start a browser login without waiting for it, for a caller that cannot wait for the user. */
const startDeviceLogin = Effect.fn("Auth.startDeviceLogin")(function* (input: {
  origin: string;
  scopes: readonly AuthScope[];
}) {
  const origin = yield* validateAuthenticationOrigin(input.origin);
  return yield* requestDeviceCode(yield* openExchange(origin, input.scopes), origin);
});

/**
 * Poll until the user approves `pending`, returning the approved session's token. Runs outside the
 * configuration writer: waiting on a person must not hold the lock every Library write needs.
 */
const awaitDeviceApproval = Effect.fn("Auth.awaitDeviceApproval")(function* (
  pending: PendingDeviceLogin,
  scopes: readonly AuthScope[],
) {
  const { discovery, send, json } = yield* openExchange(pending.origin, scopes);
  if (discovery.deviceToken === undefined)
    return yield* new DeviceLoginUnavailable({ origin: pending.origin });
  const deadline = Date.parse(pending.expiresAt);
  // RFC 8628 §3.5: wait the interval between polls, and five seconds longer after slow_down.
  let interval = pending.interval;
  while (true) {
    if ((yield* Clock.currentTimeMillis) >= deadline)
      return yield* new DeviceLoginEnded({ reason: "expired" });
    yield* Effect.sleep(Duration.seconds(interval));
    const polled = yield* send(new URL(discovery.deviceToken, pending.origin), {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.deviceCode,
        client_id: CLI_DEVICE_CLIENT_ID,
      }),
    });
    if (ok(polled)) {
      const granted = yield* polled.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(DeviceTokenResponse)),
        Effect.mapError(
          (error) =>
            new SignInFailed({ message: `Device authorization is invalid: ${error.message}` }),
        ),
      );
      return granted.access_token;
    }
    const error = yield* polled.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DeviceTokenError)),
      Effect.map((body) => body.error),
      Effect.orElseSucceed(() => undefined),
    );
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "access_denied") return yield* new DeviceLoginEnded({ reason: "denied" });
    if (error === "expired_token") return yield* new DeviceLoginEnded({ reason: "expired" });
    if (error === "invalid_grant") return yield* new DeviceLoginEnded({ reason: "invalid" });
    return yield* rejected(polled, "Device authorization");
  }
});

/** Reuse or start/save exactly one pending browser login under the configuration writer. */
export const prepareDeviceLogin = Effect.fn("Registry.prepareDeviceLogin")(
  function* (input: { origin: string; scopes: readonly AuthScope[]; home?: string }) {
    const origin = yield* validateAuthenticationOrigin(input.origin);
    const pending = yield* readPendingLogin(origin, input.home);
    if (pending) return { pending, resumed: true };
    const started = yield* startDeviceLogin({ ...input, origin });
    yield* writePendingLogin(started, input.home);
    return { pending: started, resumed: false };
  },
  (effect, input) => withConfigurationWriter(input.home, effect),
);

/** Waiting for approval never holds the writer; only matching pending cleanup and minting do. */
export const completeDeviceLogin = Effect.fn("Registry.completeDeviceLogin")(function* (input: {
  pending: PendingDeviceLogin;
  scopes: readonly AuthScope[];
  alias?: string;
  home?: string;
}) {
  const clear = withConfigurationWriter(input.home, clearPendingLogin(input.pending, input.home));
  const approvedSessionToken = yield* Effect.scoped(
    awaitDeviceApproval(input.pending, input.scopes),
  ).pipe(
    Effect.catchTag("DeviceLoginEnded", (ended) => clear.pipe(Effect.andThen(Effect.fail(ended)))),
  );
  // Redemption consumes the code even if minting later fails.
  yield* clear;
  return yield* loginEffect({
    origin: input.pending.origin,
    scopes: [...input.scopes],
    alias: input.alias,
    home: input.home,
    approvedSessionToken,
  });
}, Effect.scoped);
