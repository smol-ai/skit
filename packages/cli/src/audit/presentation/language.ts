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
