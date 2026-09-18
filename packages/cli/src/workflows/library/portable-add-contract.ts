import { Digest } from "@smolai/skit-core";
import { Schema } from "effect";

const PortableAddSkill = Schema.Struct({
  name: Schema.String,
  verbatim_path: Schema.String,
});

export const PortableAddPreview = Schema.Struct({
  kind: Schema.Literals(["plain", "authored"]),
  skills: Schema.Array(PortableAddSkill),
});
export type PortableAddPreview = typeof PortableAddPreview.Type;

export const PortableAddResult = Schema.Struct({
  collection_id: Schema.String,
  retained_version_id: Schema.String,
  snapshot_digest: Digest,
  skills: Schema.Array(PortableAddSkill),
});
export type PortableAddResult = typeof PortableAddResult.Type;
