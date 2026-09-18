/** Device-local control files that are not part of portable Artifact content. */
export const COLLECTION_CONTROL_DIRECTORY = ".skit";
export const AUTHOR_WORKSPACE_METADATA_FILE = "workspace.json";

export function isCollectionControlRootEntry(name: string, depth: number): boolean {
  return depth === 0 && name === COLLECTION_CONTROL_DIRECTORY;
}
