export const invocationOptions = ["declared", "explicit", "implicit", "host-policy"] as const;
export type InvocationOption = (typeof invocationOptions)[number];
