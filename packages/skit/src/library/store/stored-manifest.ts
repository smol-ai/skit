import { Schema } from "effect";
import { LibraryManifest } from "../library-contracts.js";
import { LibraryManifestFromV4 } from "./manifest-v4.js";
import { LibraryManifestFromV5 } from "./manifest-v5.js";
import { LibraryManifestFromV6 } from "./manifest-v6.js";
import { LibraryManifestFromV7 } from "./manifest-v7.js";

/**
 * A portable manifest as persisted by any SKIT since `skit.library.v4`, brought to the current
 * model through the linear v4 → v5 → v6 → v7 → v8 chain. Only a storage boundary decodes it; the wire
 * carries the current manifest alone.
 */
// Decode the legacy discriminators before the structurally overlapping current manifest so each
// migration and its post-migration checks run as one branch.
export const StoredLibraryManifest = Schema.Union([
  LibraryManifestFromV4,
  LibraryManifestFromV5,
  LibraryManifestFromV6,
  LibraryManifestFromV7,
  LibraryManifest,
]);
