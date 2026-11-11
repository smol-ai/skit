import type { RepositoryPolicyResult } from "@smolai/skit-core/library/setup";
import { Block } from "../../terminal/blocks.js";

export const renderRepositoryPolicy = (data: typeof RepositoryPolicyResult.Type): Block[] =>
  data.action === "list"
    ? data.repositories.length
      ? [
          Block.Table({
            columns: [{ title: "Status" }, { title: "Repository" }],
            rows: data.repositories.map((repository) => [
              [repository.status],
              [{ dim: repository.path }],
            ]),
          }),
        ]
      : [
          Block.Status({
            tone: "info",
            text: ["No repository decisions are stored for this machine."],
          }),
        ]
    : [Block.Status({ tone: "ok", text: [`${data.action} `, { dim: data.path }] })];
