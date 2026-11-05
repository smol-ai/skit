import type { Hash } from "../shared/hash.js";
import type { SkitValidationDiagnostic } from "./validation-diagnostic.js";
import type { SkitDescriptor, SkillExampleManifest } from "./schemas.js";
import type { SkillAudit, SkillAssessmentDecision } from "../auditing/skill-contracts.js";
export type RegistrySkitDescriptor = SkitDescriptor & { readonly id: string };

export interface SkitFileRecord {
  path: string;
  hash: Hash;
  bytes: number;
  mediaType: string;
  executable: boolean;
}

export interface SyncConflict {
  path: string;
  kind: "both_modified" | "delete_modify" | "binary" | "descriptor";
}

export interface SkillExampleRecord {
  path: string;
  manifest: SkillExampleManifest;
}

export interface ValidatedSkit {
  descriptor: SkitDescriptor;
  files: SkitFileRecord[];
  identity: SkitReleaseIdentity;
  diagnostics: SkitValidationDiagnostic[];
  audits: Record<string, SkillAudit>;
  assessments: Record<string, SkillAssessmentDecision>;
  examples: SkillExampleRecord[];
}

export interface SkitReleaseIdentity {
  slug: string;
  release: string;
  releaseContentHash: Hash;
  skills: Array<{
    name: string;
    contentHash: Hash;
    enabled: boolean;
  }>;
}
