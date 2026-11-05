import { RepositoryPolicyResult } from "@smolai/skit-core/library/setup";

export const repositoryOutputContracts = {
  repositoryPolicy: { id: "skit.repository.policy.v1", schema: RepositoryPolicyResult },
} as const;
