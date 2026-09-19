import type { CollectionIdentity, SkitSource } from "../contracts.js";
import { collectionIdentityProfileCatalog, collectionIdentityProfiles } from "./profiles.js";

export function collectionIdentity(
  source: SkitSource,
  declaration?: { skitId: string; authority?: string },
): CollectionIdentity {
  const input = { source, declaration };
  for (const profile of collectionIdentityProfiles) {
    const identity = profile.recognize(input);
    if (identity) return identity;
  }
  throw new Error(`No Collection Identity profile recognized Source type: ${source.type}`);
}

export function collectionRef(identity: CollectionIdentity): string {
  return collectionIdentityProfileCatalog[identity.profile].reference(identity);
}

export function skillRef(identity: CollectionIdentity | string, skillName: string): string {
  const ref = typeof identity === "string" ? identity : collectionRef(identity);
  return `${ref}#${encodeURIComponent(skillName)}`;
}

export function collectionDisplay(identity: CollectionIdentity): string {
  return collectionIdentityProfileCatalog[identity.profile].display(identity);
}

export function synchronizableCollectionIdentity(identity: CollectionIdentity): boolean {
  return collectionIdentityProfileCatalog[identity.profile].portable;
}
