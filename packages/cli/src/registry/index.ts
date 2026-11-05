/** Registry owns account selection, credentials and device-login state. */
import { Effect } from "effect";
import {
  resolveAuth,
  resolveAuthForOrigin,
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

import { prepareDeviceLogin, completeDeviceLogin } from "./device-login.js";
export type { PendingDeviceLogin } from "./device-login.js";

export type { ResolvedAuth } from "./accounts.js";

/** A concrete origin never borrows a different Registry's ambient credentials. */
const credentials = Effect.fn("Registry.credentials")(function* (
  options: {
    readonly home?: string;
    readonly registry?: string;
    readonly origin?: string;
    readonly command?: string;
  } = {},
) {
  return options.origin === undefined
    ? yield* resolveAuth(options.home, options.registry, undefined, options.command)
    : yield* resolveAuthForOrigin(options.origin, options.home);
});

export const Registry = {
  credentials,
  remotes: {
    list: listRegistryRemotes,
    add: addRegistryRemote,
    setDefault: defaultRegistryRemote,
    remove: removeRegistryRemote,
  },
  status: registryStatus,
  logout: logoutEffect,
  login: loginEffect,
  reuseLogin,
  loginTarget: resolveLoginTarget,
  prepareDeviceLogin,
  completeDeviceLogin,
  source: resolveRegistryLocator,
} as const;
