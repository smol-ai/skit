import type { CollectionIdentity, SkitSource } from "../contracts.js";

export interface CollectionIdentityInput {
  source: SkitSource;
  declaration?: { skitId: string; authority?: string };
}

export type CollectionIdentityByProfile = {
  [TIdentity in CollectionIdentity as TIdentity["profile"]]: TIdentity;
};

export interface CollectionIdentityProfile {
  kind: CollectionIdentity["profile"];
  recognitionPriority: number;
  portable: boolean;
  recognize(input: CollectionIdentityInput): CollectionIdentity | undefined;
  reference(identity: CollectionIdentity): string;
  display(identity: CollectionIdentity): string;
}

type CollectionIdentityProfileDefinition<TKind extends keyof CollectionIdentityByProfile> = Omit<
  CollectionIdentityProfile,
  "kind" | "recognize" | "reference" | "display"
> & {
  recognize(input: CollectionIdentityInput): CollectionIdentityByProfile[TKind] | undefined;
  reference(identity: CollectionIdentityByProfile[TKind]): string;
  display(identity: CollectionIdentityByProfile[TKind]): string;
};

export function defineCollectionIdentityProfile<
  const TKind extends keyof CollectionIdentityByProfile,
>(
  kind: TKind,
  definition: CollectionIdentityProfileDefinition<TKind>,
): CollectionIdentityProfile & { readonly kind: TKind } {
  const identityForProfile = (identity: CollectionIdentity): CollectionIdentityByProfile[TKind] => {
    if (identity.profile !== kind)
      throw new Error(`Expected Collection Identity profile ${kind}, received ${identity.profile}`);
    return identity as CollectionIdentityByProfile[TKind];
  };
  return {
    kind,
    recognitionPriority: definition.recognitionPriority,
    portable: definition.portable,
    recognize: definition.recognize,
    reference: (identity) => definition.reference(identityForProfile(identity)),
    display: (identity) => definition.display(identityForProfile(identity)),
  };
}
