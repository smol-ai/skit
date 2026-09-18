/** Human-facing language for stable machine codes. Never fall back to displaying the code. */
const conditionHeadlines: Readonly<Record<string, string>> = {
  DANGLING_SYMLINK: "Dangling symlink",
  INVALID_OWNERSHIP_MARKER: "Invalid SKIT ownership marker",
  MISSING_ROOT: "Harness skills directory is absent",
  ORPHANED_PROJECTION_CLAIM: "Skill copy claims an unknown Library entry",
  PROJECTION_CONFLICT: "Local skill copy conflicts with the Library",
  PROJECTION_DRIFT: "Local skill copy differs from the Library",
  UNREADABLE_PATH: "Harness skills directory could not be read",
};

export function conditionHeadline(code: string, fallback: string): string {
  return conditionHeadlines[code] ?? fallback;
}

export function severityHeadline(severity: "info" | "warning" | "error"): string {
  switch (severity) {
    case "info":
      return "Note";
    case "warning":
      return "Warning";
    case "error":
      return "Error";
  }
}

export function capabilityLabel(kind: string): string {
  return (
    {
      skill: "Skill",
      plugin: "Plugin",
      "mcp-server": "MCP server",
      rule: "Rule",
      marketplace: "Marketplace",
    }[kind] ?? "Capability"
  );
}

export function changeActionLabel(action: "add" | "update" | "remove"): string {
  return { add: "Add", update: "Update", remove: "Remove" }[action];
}

export function projectionStatusLabel(status: string): string {
  return (
    {
      pending: "waiting to be installed",
      installed: "installed",
      drifted: "differs from the Library",
      conflicted: "conflicts with local changes",
      unsupported: "not supported by this Harness",
    }[status] ?? "status unavailable"
  );
}

export function reconciliationOperationLabel(operation: string): string {
  return (
    {
      install: "Installed",
      update: "Updated",
      repair: "Repaired",
      disable: "Disabled",
      uninstall: "Uninstalled",
      adopt: "Adopted",
    }[operation] ?? "Changed"
  );
}
