import type { CollectionSource } from "@smolai/skit-core/library/queries";
import { Block, type Field } from "../../terminal/blocks.js";
import { metadataSource } from "./skill-metadata.js";

const sourceKinds = {
  "authored-workspace": "Author workspace",
  registry: "Registry release",
  github: "GitHub",
  git: "Git repository",
  local: "Local directory",
  archive: "Archive",
  url: "URL",
  "well-known": "Website",
} satisfies Record<CollectionSource["kind"], string>;

export function collectionTitle(label: string, source?: CollectionSource): string {
  return source === undefined ? label : `${source.name || label} (${sourceKinds[source.kind]})`;
}

export function collectionWarnings(source?: CollectionSource): string[] {
  if (source?.kind !== "authored-workspace") return [];
  switch (source.workspace_status) {
    case "unconnected":
      return ["Not connected to a Registry"];
    case "unavailable":
      return [
        source.locator
          ? "Workspace metadata unavailable; showing last-known location"
          : "Workspace location is not recorded",
      ];
    case "identity-mismatch":
      return ["Folder identity does not match this workspace"];
    default:
      return [];
  }
}

function collectionDetails(source?: CollectionSource): string[] {
  if (source === undefined) return [];
  if (source.kind === "authored-workspace")
    return [
      source.locator
        ? `Source: ${metadataSource(source.locator)}`
        : "Workspace location unavailable",
      ...(source.authority ? [`Registry: ${source.authority}`] : []),
      ...collectionWarnings(source),
    ];
  return [
    source.kind === "registry"
      ? `Registry: ${source.authority}`
      : `Source: ${metadataSource(source.locator)}`,
    ...(source.revision ? [`Revision: ${source.revision}`] : []),
  ];
}

/** Which Collection a result is about, and where it comes from, as the head of its output. */
export function collectionIdentity(label: string, source?: CollectionSource): Block[] {
  const rows: Field[] =
    source === undefined
      ? []
      : source.kind === "authored-workspace"
        ? [
            ...(source.locator
              ? [{ label: "Source", value: [{ dim: metadataSource(source.locator) }] }]
              : []),
            ...(source.authority ? [{ label: "Registry", value: [source.authority] }] : []),
          ]
        : [
            ...(source.kind !== "registry"
              ? [{ label: "Source", value: [{ dim: metadataSource(source.locator) }] }]
              : source.authority
                ? [{ label: "Registry", value: [source.authority] }]
                : []),
            ...(source.revision ? [{ label: "Revision", value: [source.revision] }] : []),
          ];
  return [
    Block.Heading({ text: collectionTitle(label, source) }),
    ...(rows.length ? [Block.Fields({ rows })] : []),
    ...(source?.kind === "authored-workspace" && !source.locator
      ? [Block.Status({ tone: "warn", text: ["Workspace location unavailable"] })]
      : []),
    ...collectionWarnings(source).map((warning) => Block.Status({ tone: "warn", text: [warning] })),
  ];
}

/** Effect's autocomplete searches titles, so the disambiguating path/authority belongs there. */
export function collectionChoiceTitle(label: string, source?: CollectionSource): string {
  if (source === undefined) return `${label} (Source unavailable)`;
  const locator = source.kind === "registry" ? source.authority : source.locator;
  return `${source.name || label} (${sourceKinds[source.kind]}: ${locator ? metadataSource(locator) : "location unavailable"})`;
}

export const collectionHint = (source?: CollectionSource) => collectionDetails(source).join(" | ");

/** Shell-quote a source path so the suggested command works for spaces and shell metacharacters. */
const workspaceArgument = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
export const workspaceEnableCommand = (path: string) =>
  `skit enable ${workspaceArgument(path)} --all --global`;
export const workspaceInitCommand = (path: string) => `skit author init ${workspaceArgument(path)}`;

export function collectionEnablement(total: number, enabled: number): string {
  if (enabled === 0) return "Disabled";
  return enabled === total ? "Enabled" : `${enabled}/${total} skills enabled`;
}
