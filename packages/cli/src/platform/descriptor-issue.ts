import { DescriptorIssue } from "@smolai/skit-core/universal/consumer";
import { schemaFailure } from "./schema-failure.js";

/** Parser locations and schema facts acquire wording only at this boundary. */
export const descriptorIssue = (issue: DescriptorIssue): string =>
  DescriptorIssue.match(issue, {
    JsonSyntax: ({ offset, line, column }) =>
      `Invalid JSON syntax${line === undefined ? (offset === undefined ? "" : ` at character ${offset}`) : ` at line ${line}, column ${column}`}`,
    YamlSyntax: ({ errors }) =>
      errors
        .map(
          (error) =>
            `${error.code.toLowerCase().replaceAll("_", " ")}${error.line === undefined ? ` at character ${error.start}` : ` at line ${error.line}, column ${error.column}`}`,
        )
        .join("; "),
    YamlValue: () => "YAML aliases or values could not be read",
    Schema: ({ failure }) => schemaFailure(failure),
  });
