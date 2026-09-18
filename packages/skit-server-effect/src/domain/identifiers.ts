import { normalizeRegistryNamespace } from "@smolai/skit-core/universal/consumer";

export const normalizeNamespace = (value: string): string | undefined =>
  normalizeRegistryNamespace(value) ?? undefined;
