/** Registry owns account selection, credentials and device-login state. */
import { AuthenticationRequired } from "./failures.js";
import { officialRegistryOrigin } from "./accounts.js";
import { Effect } from "effect";
import {
  registryCredentials,
  resolveRegistryLocator,
  registryStatus,
  logoutEffect,
  loginEffect,
  reuseLogin,
  resolveLoginTarget,
  listRegistryRemotes,
  addRegistryRemote,
  defaultRegistryRemote,
  removeRegistryRemote,
} from "./auth.js";

import { prepareDeviceLogin, completeDeviceLogin, readPendingLogin } from "./device-login.js";
export type { PendingDeviceLogin } from "./device-login.js";

export type { ResolvedAuth } from "./accounts.js";

const librarySyncAccount = Effect.fn("Registry.librarySyncAccount")(function* (registry?: string) {
  const account = yield* registryCredentials({ registry, command: "skit sync" });
  const origin = account.origin ?? officialRegistryOrigin;
  if (!account.token) return yield* new AuthenticationRequired({ origin, scopes: "library:sync" });
  return { ...account, origin, token: account.token };
});

export const Registry = {
  credentials: registryCredentials,
  librarySyncAccount,
  remotes: {
    list: listRegistryRemotes,
    add: addRegistryRemote,
    setDefault: defaultRegistryRemote,
    remove: removeRegistryRemote,
  },
  status: registryStatus,
  logout: logoutEffect,
  login: loginEffect,
  // A pending browser login takes precedence over an older stored credential on continuation.
  reuseLogin: Effect.fn("Registry.reuseLogin")(function* (input: Parameters<typeof reuseLogin>[0]) {
    if (yield* readPendingLogin(input.origin, input.home, input.scopes)) return undefined;
    return yield* reuseLogin(input);
  }),
  loginTarget: resolveLoginTarget,
  prepareDeviceLogin,
  completeDeviceLogin,
  source: resolveRegistryLocator,
} as const;
