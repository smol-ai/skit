import {
  ListingUnavailableReason,
  ListingReadReason,
} from "@smolai/skit-core/harnesses/listing-contracts";
import { Schema } from "effect";
import { schemaFailure } from "../library/schema-failure";
import { errorMessage, SchemaFailure } from "@smolai/skit-core/shared";
import { harnessDiscoveryFailure } from "../library/discovery-failures";
import { harnessProbeFailure } from "../library/probe-failures";

const nativeFailure = (failure: unknown) =>
  Schema.is(SchemaFailure)(failure) ? schemaFailure(failure) : errorMessage(failure);

const listingReadFailure = (reason: ListingReadReason): string =>
  ListingReadReason.match(reason, {
    ReadFailed: ({ path, failure }) => `Cannot read ${path}: ${nativeFailure(failure)}`,
    DirectoryLimitExceeded: ({ path, limit, actual }) =>
      `Skill discovery reached ${actual} directories at ${path}, exceeding the ${limit}-directory limit.`,
    InvalidFrontmatter: ({ path }) => `Malformed skill metadata: ${path}`,
  });
export const listingUnavailable = (reason: ListingUnavailableReason): string =>
  ListingUnavailableReason.match(reason, {
    CustomRoot: ({ roots }) =>
      `Custom Codex roots${roots.length ? ` (${roots.join(", ")})` : ""} do not describe native discovery. Run doctor without those overrides to check the native listing.`,
    DescriptionMissing: ({ name, path }) =>
      `Codex did not provide a description for ${name} at ${path}; its listing demand cannot be estimated.`,
    DiscoveryFailed: ({ failure }) => harnessDiscoveryFailure(failure).message,
    ListingReadFailed: ({ failure }) => listingReadFailure(failure.reason),
    MetadataInvalid: ({ failure }) => `${failure.kind} is invalid: ${failure.path}`,
    NativeReadFailed: ({ failure }) => nativeFailure(failure),
    NativeDiscoveryUnavailable: ({ status, probeFailure }) =>
      probeFailure
        ? harnessProbeFailure(probeFailure)
        : `Native discovery is ${status}; no listing estimate is available.`,
  });
