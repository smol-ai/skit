import type { ContractData, ContractDataForId, ContractKey } from "./output-contracts.js";
import type { CommandResult } from "./types.js";
import type { RenderContext } from "../terminal/contracts.js";
import { terminalData } from "../terminal/text.js";
import { harnessLabel } from "@smolai/skit-core/harnesses";
import { createColors } from "picocolors";
import { renderUsage } from "../library/presentation/usage.js";
import { renderInventory } from "../library/presentation/inventory.js";
import { renderSetEnabled } from "../library/enable.js";
import { renderRemove, renderRemovePlan } from "../library/remove.js";
import { renderCheck } from "../library/check.js";
import { renderLibrarySync } from "../library/presentation/sync.js";
import { renderLibraryList } from "../library/presentation/list.js";
import { renderAuditV1Alpha4 } from "../audit/presentation/report.js";
import { severityHeadline } from "../audit/presentation/language.js";
import {
  renderAdd,
  renderAddPreview,
  renderUpdate,
  renderUpdatePlan,
} from "../library/presentation/update.js";
import { renderDoctor } from "../library/presentation/doctor.js";
import {
  renderSetup,
  renderSetupApplied,
  renderSetupComparison,
  renderSetupReview,
  renderSetupFailed,
  renderSetupUndo,
} from "../library/setup.js";
import { renderRecoveryList, renderRecovery } from "../library/presentation/recovery.js";
import { renderLibraryHistory } from "../library/presentation/history.js";
import {
  renderProjectionRetention,
  renderProjectionRetentionPlan,
} from "../library/presentation/retention.js";

type ContractPresenters = {
  [K in ContractKey]: (data: ContractData<K>, context: RenderContext) => string;
};

function renderValidation(data: ContractDataForId<"skit.validate.v3">): string {
  const headline = {
    valid: "SKIT is valid",
    "valid-with-warnings": "SKIT is valid with warnings",
    "policy-blocked": "SKIT is structurally valid but blocked by security policy",
    invalid: "SKIT validation failed",
  }[data.status];
  if (!data.diagnostics.length) return headline;

  return [
    headline,
    "",
    ...data.diagnostics.flatMap((diagnostic) => [
      `${severityHeadline(diagnostic.severity)}${diagnostic.path ? ` · ${diagnostic.path}` : ""}`,
      `  ${diagnostic.message}`,
    ]),
  ].join("\n");
}

function renderSecurityReview(data: ContractDataForId<"skit.security.review.v4">): string {
  return data.audit.findings.length
    ? data.assessment.findingDecisions
        .map((finding) => `${finding.fingerprint} ${finding.disposition} (${finding.ruleId})`)
        .join("\n")
    : "No security findings";
}

function renderAuthorInit(data: ContractDataForId<"skit.init.v1">): string {
  const lines = [`Initialized SKIT at ${data.path}`];
  if (data.library_registration === "removed")
    lines.push("Library Entry remains removed; run `skit author init --register` to restore it");
  if (data.discovered?.skillEntries.length) {
    lines.push("", "Discovered Skills:");
    for (const skill of data.discovered.skillEntries) lines.push(`  ${skill.name} · ${skill.path}`);
  }
  return lines.join("\n");
}

function renderAuthorInvocation(data: ContractDataForId<"skit.author.invocation.v1">): string {
  const changed = data.generated.filter((item) => item.changed);
  if (!changed.length)
    return "Every declared invocation policy is already written into its Harness metadata";
  return [
    data.dryRun
      ? "These files do not yet express their declared invocation policy:"
      : "Wrote the declared invocation policy into:",
    ...changed.map((item) => `  ${item.path} (${item.skill}, ${item.harness}, ${item.policy})`),
  ].join("\n");
}

function renderAuthorDelete(data: ContractDataForId<"skit.author.delete.v2">): string {
  const releases = data.release_versions.join(", ") || "none";
  if (data.status === "delete_ready")
    return `Would delete ${data.skit_id}: ${data.revisions} revision(s), Releases: ${releases}`;
  if (data.status === "absent") return `${data.skit_id} is already absent`;
  return `Deleted ${data.skit_id}: ${data.revisions} revision(s), Releases: ${releases}${data.archive_cleanup === "deferred" ? "; archive cleanup deferred" : ""}`;
}

function registryLabel(registry: string): string {
  try {
    return new URL(registry).host;
  } catch {
    return registry;
  }
}

function authoredSkitLabel(identity: string): string {
  try {
    return new URL(identity).pathname.replace(/^\//, "");
  } catch {
    return identity;
  }
}

function renderAuthorList(data: ContractDataForId<"skit.author.list.v2">): string {
  const registry = registryLabel(data.registry);
  if (!data.skits.length) return `No authored SKITs · ${registry}`;
  const rows = data.skits.map((skit) => [
    authoredSkitLabel(skit.identity),
    skit.visibility,
    skit.current_revision_published ? "published" : "unpublished",
    skit.most_recent_release_version ?? "—",
  ]);
  const headings = ["SKIT", "ACCESS", "CURRENT", "LATEST"];
  const widths = headings.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row[column].length)),
  );
  const format = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  return [
    `${data.skits.length} authored ${data.skits.length === 1 ? "SKIT" : "SKITs"} · ${registry}`,
    "",
    format(headings),
    ...rows.map(format),
  ].join("\n");
}

function renderRegistryChange(data: ContractDataForId<"skit.registry.remote.v1">): string {
  if (data.action === "removed") return `Removed Registry ${data.name}`;
  if (data.action === "defaulted") return `Default Registry: ${data.name}  ${data.origin}`;
  return `${data.name}  ${data.origin}`;
}

function renderRegistryList(data: ContractDataForId<"skit.registry.list.v1">): string {
  return data.registries.length
    ? data.registries
        .map(
          (registry) =>
            `${registry.name}${registry.isDefault ? " (default)" : ""}  ${registry.origin}`,
        )
        .join("\n")
    : "No Registries configured";
}

const authScopeLabels: Readonly<Record<string, string>> = {
  "library:sync": "Library sync",
  "authoring:write": "authoring",
  "publication:write": "publication",
};

function renderAuthAccess(scopes: ReadonlyArray<string>): string {
  if (!scopes.length) return "Unknown";
  return scopes.map((scope) => authScopeLabels[scope] ?? scope).join(", ");
}

function renderAuthExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return "Unknown";
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return expiresAt;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(expiry);
}

function renderAuthStatus(
  data: ContractDataForId<"skit.auth.status.v3">,
  context: RenderContext,
): string {
  if (!data.credentials.length) return "No credentials configured; run `skit auth login`";
  return data.credentials
    .map((credential) => {
      const name = credential.aliases.join(", ") || credential.origin;
      const flags = [
        credential.isDefault ? "default" : undefined,
        credential.source === "environment" ? "environment" : undefined,
      ].filter(Boolean);
      return [
        `Credential configured for ${name}${flags.length ? ` (${flags.join(", ")})` : ""}`,
        ...(credential.aliases.length ? [`Registry: ${credential.origin}`] : []),
        `Access: ${renderAuthAccess(credential.scopes)}`,
        `Expires: ${renderAuthExpiry(credential.expiresAt)}${credential.expired ? " (expired)" : ""}`,
        `Stored in: ${
          {
            keychain: "macOS Keychain",
            "secret-service": "the system secret store",
            file: "the credential file (no system secret store was available)",
            environment: "SKIT_TOKEN",
          }[credential.storage]
        }`,
        ...(context.detail === "full" ? [`Credential: ${credential.tokenPrefix}`] : []),
      ].join("\n");
    })
    .join("\n\n");
}

function renderAuthLogin(
  data: ContractDataForId<"skit.auth.login.v2">,
  context: RenderContext,
): string {
  const name = data.alias ?? data.origin;
  return [
    `${data.alreadyAuthenticated ? "Already authenticated" : "Authenticated"} to ${name}${data.defaultRegistry && data.defaultRegistry === data.alias ? " (default)" : ""}`,
    ...(data.alias ? [`Registry: ${data.origin}`] : []),
    `Access: ${renderAuthAccess(data.scopes)}`,
    `Expires: ${renderAuthExpiry(data.expiresAt)}`,
    ...(data.credentialPath ? [`Saved credential: ${data.credentialPath}`] : []),
    "Next: skit sync to preview; skit sync --apply to apply. No login needed for future commands.",
    ...(context.detail === "full" ? [`Credential: ${data.tokenPrefix}`] : []),
    ...(data.warning ? [`Warning: ${data.warning}`] : []),
  ].join("\n");
}

function renderHarnessProbe(
  data: ContractDataForId<"skit.experimental.harness-probe.v1alpha1">,
): string {
  return data.probes
    .map((probe) =>
      [
        harnessLabel(probe.harnessId),
        `  Status: ${{ installed: "Installed", missing: "Not installed", failed: "Probe failed" }[probe.status]}`,
        `  executable: ${probe.executablePath ?? "not found"}`,
        `  resolved: ${probe.resolvedPath ?? "n/a"}`,
        `  version: ${probe.version ?? "unknown"}`,
        ...(probe.error ? [`  error: ${probe.error}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
}

function renderAuthorSync(data: ContractDataForId<"skit.author.sync.v5">): string {
  switch (data.status) {
    case "first_sync_ready":
      return `Sync ready for ${data.identity.locator} (${data.visibility}); no Release will be published; rerun with --apply`;
    case "ready":
      return `Ready to ${data.action}; rerun with --apply`;
    case "blocked":
      return `Sync paused: ${data.deleting} of ${data.of} files removed. Remote files are unchanged. To send these deletions, rerun with --apply --allow-large-deletion.`;
    case "created":
      return `Connected ${data.identity.locator}; saved revision ${data.revision_id}`;
    case "up_to_date":
      return `Workspace is already synchronized (${data.revision_id})`;
    case "pulled":
      return `Updated ${data.paths.length} file(s) from the Registry (${data.revision_id})`;
    case "pushed":
      return `Synced local changes to the Registry (${data.revision_id})`;
    case "merged":
      return [
        `Merged local and remote changes (${data.revision_id})`,
        ...data.choices.map(
          (choice) => `  ${choice.path}: kept the ${choice.kept} version (${choice.kind})`,
        ),
      ].join("\n");
  }
}

const contractPresenters: ContractPresenters = {
  versionReport: (data) =>
    [
      `${data.version} (${data.build.kind})`,
      ...(data.build.commit ? [`Commit: ${data.build.commit}`] : []),
      data.update.status === "update-available"
        ? `Update available: ${data.update.available}\n${data.update.upgrade}`
        : data.update.status === "check-unavailable"
          ? "Update check unavailable."
          : data.update.status === "development-build"
            ? "Development build; release versions are not compared."
            : data.update.status === "channel-unavailable"
              ? `No usable release on ${data.update.channel}.`
              : data.update.status === "ahead"
                ? `Ahead of ${data.update.channel} (${data.update.available}).`
                : `Up to date on ${data.update.channel}.`,
    ].join("\n"),
  version: (data) => data.version,
  init: renderAuthorInit,
  authorInvocation: renderAuthorInvocation,
  authorDelete: renderAuthorDelete,
  publish: (data) =>
    `Published ${data.release.version}${data.release.revision_id ? ` from ${data.release.revision_id}` : ""}`,
  sync: renderAuthorSync,
  librarySync: (data, context) => renderLibrarySync(data, createColors(context.color)),
  libraryHistory: renderLibraryHistory,
  list: (data, context) => renderLibraryList(data, createColors(context.color)),
  experimentalAuditV1Alpha4: renderAuditV1Alpha4,
  authorList: renderAuthorList,
  add: renderAdd,
  addPreview: renderAddPreview,
  update: renderUpdate,
  updatePlan: renderUpdatePlan,
  projectionRetentionPlan: renderProjectionRetentionPlan,
  projectionRetention: renderProjectionRetention,
  remove: renderRemove,
  removePlan: renderRemovePlan,
  enable: (data) => renderSetEnabled(data, true),
  enablePlan: (data) => renderSetEnabled(data, false),
  disable: (data) => renderSetEnabled(data, true),
  disablePlan: (data) => renderSetEnabled(data, false),
  doctor: renderDoctor,
  usage: (data) => renderUsage(data),
  inventory: (data, context) => renderInventory(data, data.machine, createColors(context.color)),
  setupUndo: renderSetupUndo,
  recoveryList: renderRecoveryList,
  recovery: renderRecovery,
  setupComparison: renderSetupComparison,
  setupReview: renderSetupReview,
  setupFailed: renderSetupFailed,
  setup: renderSetup,
  setupApplied: renderSetupApplied,
  repositoryPolicy: (data) =>
    data.action === "list"
      ? data.repositories.length
        ? data.repositories
            .map((repository) => `${repository.status} · ${repository.path}`)
            .join("\n")
        : "No repository decisions are stored for this machine."
      : `${data.action} · ${data.path}`,
  authLogout: (data) => `Logged out from ${data.origin}`,
  feedbackSend: (data) => {
    const from = [
      ...(data.signedIn ? ["signed in"] : []),
      ...(data.email === undefined ? [] : [`with contact ${data.email}`]),
    ];
    return `Sent feedback to ${data.recipient} (${data.id})${from.length === 0 ? ", anonymously" : `, ${from.join(" ")}`}. Thank you.`;
  },
  authStatus: renderAuthStatus,
  authLogin: renderAuthLogin,
  authLoginPending: (data) =>
    [
      `Open ${data.verificationUri} and enter the code ${data.userCode} to approve this login.`,
      `The code expires at ${data.expiresAt}.`,
      `Next: ${data.next} once it is approved.`,
    ].join("\n"),
  registryRemote: renderRegistryChange,
  registryList: renderRegistryList,
  serverBootstrap: (data) =>
    `${
      data.status === "already_complete"
        ? `Server setup was already complete at ${data.origin}`
        : `Server setup complete at ${data.origin}`
    }\nIf email verification is enabled, follow the browser result. If delivery failed, use Resend on the sign-in page.\nNext: skit auth login ${data.origin}`,
  check: renderCheck,
  experimentalHarnessProbe: renderHarnessProbe,
  validate: renderValidation,
  securityReview: renderSecurityReview,
  securityAccept: renderSecurityReview,
};

export function renderContract<K extends ContractKey>(
  result: CommandResult<K>,
  context: RenderContext,
): string {
  return contractPresenters[result.contract](terminalData(result.data), context);
}
