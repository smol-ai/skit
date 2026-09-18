/**
 * A deeply mutable view of persisted state.
 *
 * The state schema marks only the fields the reconciler may revise in place. A test standing
 * in for an edit made outside skit — a device writing state.json directly — is not bound by
 * that contract, so it takes this view rather than widening the production schema.
 */
export type DeviceEdit<T> = { -readonly [K in keyof T]: DeviceEdit<T[K]> };

export const asDeviceEdit = <T>(state: T): DeviceEdit<T> => state as DeviceEdit<T>;
