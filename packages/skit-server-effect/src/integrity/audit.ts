const RULES = [
  {
    id: "process.api-execution",
    capability: "process.execute",
    pattern:
      /(?:\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(|child_process|subprocess\.|os\.system\s*\(|Bun\.spawn\b|Deno\.Command\b)/i,
    critical: false,
  },
  {
    id: "process.shell-marker",
    capability: "process.execute",
    pattern: /(?:!`|```!)/i,
    critical: false,
  },
  {
    id: "process.shell-fence",
    capability: "process.execute",
    pattern: /```(?:bash|sh|zsh|shell|console)\b/i,
    critical: false,
  },
  {
    id: "filesystem.write-operation",
    capability: "filesystem.write",
    pattern: /(?:writeFile|appendFile|apply_patch|\brm\s|unlink)/i,
    critical: false,
  },
  {
    id: "git.commit-command",
    capability: "git.commit",
    pattern: /git\s+commit/i,
    critical: false,
  },
  {
    id: "git.push-command",
    capability: "git.push",
    pattern: /git\s+push/i,
    critical: false,
  },
  {
    id: "network.request-syntax",
    capability: "network.request",
    pattern: /(?:https?:\/\/|\bfetch\s*\(|curl\s)/i,
    critical: false,
  },
  {
    id: "cloud.deployment-command",
    capability: "cloud.deploy",
    pattern:
      /(?:\bwrangler\s+(?:deploy|publish)\b|\bvercel\s+(?:deploy\b|--prod\b)|\bnetlify\s+deploy\b|\bfly(?:ctl)?\s+deploy\b|\bsst\s+deploy\b|\bserverless\s+deploy\b|\bterraform\s+apply\b|\bkubectl\s+apply\b|\bnpm\s+publish\b|\bgh\s+workflow\s+run\b)/i,
    critical: false,
  },
  {
    id: "secret.reference",
    capability: "secret.use",
    pattern: /(?:API_KEY|TOKEN|PASSWORD|credential)/i,
    critical: false,
  },
  {
    id: "process.dynamic-eval",
    capability: "process.execute",
    pattern: /(?:eval\s*\(|new Function)/i,
    critical: true,
  },
] as const;

const CAPABILITY_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "process.execute": ["shell"],
  "filesystem.write": ["filesystem_write"],
  "network.request": ["network"],
  "git.commit": ["shell"],
  "git.push": ["shell", "network"],
  "cloud.deploy": ["shell", "network"],
  "secret.use": ["network"],
};

export const publicationBlockReasons = (
  text: string,
  declaredCapabilities: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const matched = RULES.filter(({ pattern }) => pattern.test(text));
  const inferred = [...new Set(matched.map(({ capability }) => capability))];
  const undeclared = inferred.filter(
    (capability) =>
      !declaredCapabilities.includes(capability) &&
      !(CAPABILITY_ALIASES[capability] ?? []).every((alias) =>
        declaredCapabilities.includes(alias),
      ),
  );
  return [
    ...(undeclared.length > 0 ? ["UNDECLARED_CAPABILITY"] : []),
    ...(matched.some(({ critical }) => critical) ? ["CRITICAL_EVIDENCE"] : []),
    ...(/(?:do not ask|without (?:asking|confirmation)|never ask|JFDI)/i.test(text)
      ? ["APPROVAL_SUPPRESSION"]
      : []),
    ...(/(?:full access|unrestricted|ignore (?:scope|instructions)|take ownership)/i.test(text)
      ? ["AUTHORITY_EXPANSION"]
      : []),
  ];
};
