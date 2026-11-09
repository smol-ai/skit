import type { RepositoryPolicyResult } from "@smolai/skit-core/library/setup";

export const renderRepositoryPolicy = (data: typeof RepositoryPolicyResult.Type) =>
  data.action === "list"
    ? data.repositories.length
      ? data.repositories
          .map((repository) => `${repository.status} | ${repository.path}`)
          .join("\n")
      : "No repository decisions are stored for this machine."
    : `${data.action} | ${data.path}`;
