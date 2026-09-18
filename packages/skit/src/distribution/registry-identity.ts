const RESERVED_NAMESPACES = new Set(["api", "admin", "_", "well-known"]);
const REGISTRY_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function normalizeSegment(value: string): string | null {
  const normalized = value.normalize("NFC").toLowerCase();
  return REGISTRY_SEGMENT.test(normalized) ? normalized : null;
}

export function normalizeRegistryNamespace(value: string): string | null {
  const normalized = normalizeSegment(value);
  return normalized && !RESERVED_NAMESPACES.has(normalized) ? normalized : null;
}

export function normalizeRegistrySkitSlug(value: string): string | null {
  return normalizeSegment(value);
}
