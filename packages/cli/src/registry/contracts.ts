import { Schema } from "effect";

export const RegistryRemote = Schema.Struct({
  name: Schema.String,
  origin: Schema.String,
  isDefault: Schema.Boolean,
});
export type RegistryRemote = typeof RegistryRemote.Type;

export const RegistryRemoteChange = RegistryRemote.pipe(
  Schema.fieldsAssign({ action: Schema.Literals(["added", "defaulted", "removed"]) }),
);
export type RegistryRemoteChange = typeof RegistryRemoteChange.Type;

export const RegistryRemoteList = Schema.Struct({ registries: Schema.Array(RegistryRemote) });
export type RegistryRemoteList = typeof RegistryRemoteList.Type;
