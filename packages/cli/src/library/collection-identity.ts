import { collectionIdentity, type CollectionIdentity, type SkitSource } from "@smolai/skit-core";

export function resolvedCollectionIdentity(
  source: Parameters<typeof collectionIdentity>[0],
  descriptorKind: "declared" | "generated",
  declaration?: { skitId: string; authority?: string },
): CollectionIdentity {
  return collectionIdentity(source, descriptorKind === "generated" ? undefined : declaration);
}

export function registrySourceDeclaration(source: SkitSource, authority?: string) {
  return source.type === "registry"
    ? {
        skitId: source.ref.split("@")[0],
        ...((source.authority ?? authority) ? { authority: source.authority ?? authority } : {}),
      }
    : undefined;
}
