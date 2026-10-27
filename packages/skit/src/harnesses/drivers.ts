import { Effect, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import type { HarnessName } from "../contracts.js";
import type { LibraryState } from "../library/library-state.js";
import type { UsageHarness } from "../usage/contracts.js";
import {
  claudeTranscriptGrammar,
  codexTranscriptGrammar,
  type TranscriptGrammar,
} from "../usage/events.js";
import { harnessProfiles } from "./catalog.js";
import type { HarnessProfile } from "./contracts.js";
import {
  invocationMetadataAdapters,
  type InvocationMetadataAdapter,
} from "./invocation-metadata.js";
import { readClaudeListingSnapshot } from "./skill-listing/claude.js";
import { readCodexListingBudget } from "./skill-listing/codex.js";
import type { ListingBudget, ListingHarness } from "./skill-listing/contracts.js";
import type { ListingOptions } from "./skill-listing/discovery.js";

/** Where a Harness keeps the local transcripts SKIT reads for Skill usage, and how to read them. */
export interface HarnessTranscripts {
  /** The environment variable naming the Harness's home, and its default under the user's home. */
  readonly home: { readonly variable: string; readonly directory: string };
  /** Transcript directories under that home. */
  readonly directories: readonly string[];
  readonly grammar: TranscriptGrammar;
}

/** Estimate how much of the Harness's skill listing the Library's Skills occupy. */
export type HarnessListing = (
  state: LibraryState,
  options: ListingOptions,
) => Effect.Effect<
  ListingBudget,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
>;

/** Everything SKIT knows about driving one Harness. A capability a Harness lacks is absent. */
export type HarnessDriver<H extends HarnessName = HarnessName> = {
  /** The documented catalog: roots, frontmatter and listing contracts. */
  readonly profile: HarnessProfile;
  readonly label: string;
  /** Names a user may type for this Harness. */
  readonly aliases: readonly string[];
  /** The executable SKIT looks for on PATH and probes with `--version`. */
  readonly probeCommand: string;
  /** Paths, besides the native global root's parent, whose presence shows the Harness installed. */
  readonly installMarkers: readonly string[];
  /**
   * How a device-local root override applies. `replaces`: it stands in for the Harness's global
   * skills directory and shows the Harness in use. `extends`: it adds roots to scan beside every readable
   * global root and never implies the Harness is installed.
   */
  readonly rootOverride: "replaces" | "extends";
  readonly invocation: InvocationMetadataAdapter;
} & (H extends UsageHarness
  ? { readonly transcripts: HarnessTranscripts }
  : { readonly transcripts?: undefined }) &
  (H extends ListingHarness
    ? { readonly listing: HarnessListing }
    : { readonly listing?: undefined });

export const harnessDrivers: { readonly [H in HarnessName]: HarnessDriver<H> } = {
  codex: {
    profile: harnessProfiles.codex,
    label: "Codex",
    aliases: ["codex"],
    probeCommand: "codex",
    installMarkers: ["/etc/codex"],
    rootOverride: "replaces",
    invocation: invocationMetadataAdapters.codex,
    transcripts: {
      home: { variable: "CODEX_HOME", directory: ".codex" },
      directories: ["sessions", "archived_sessions"],
      grammar: codexTranscriptGrammar,
    },
    listing: readCodexListingBudget,
  },
  "claude-code": {
    profile: harnessProfiles["claude-code"],
    label: "Claude Code",
    aliases: ["claude", "claude-code"],
    probeCommand: "claude",
    installMarkers: [],
    rootOverride: "replaces",
    invocation: invocationMetadataAdapters["claude-code"],
    transcripts: {
      home: { variable: "CLAUDE_CONFIG_DIR", directory: ".claude" },
      directories: ["projects"],
      grammar: claudeTranscriptGrammar,
    },
    listing: (state, options) =>
      readClaudeListingSnapshot(state, {
        ...options,
        configHome: options.configHome ?? join(options.home, ".config"),
      }).pipe(Effect.map((snapshot) => snapshot.budget)),
  },
  opencode: {
    profile: harnessProfiles.opencode,
    label: "OpenCode",
    aliases: ["opencode"],
    probeCommand: "opencode",
    installMarkers: [],
    rootOverride: "replaces",
    invocation: invocationMetadataAdapters.opencode,
  },
  devin: {
    profile: harnessProfiles.devin,
    label: "Devin",
    aliases: ["devin"],
    probeCommand: "devin",
    installMarkers: [],
    rootOverride: "extends",
    invocation: invocationMetadataAdapters.devin,
  },
};

/** The Harness a user-facing name refers to. */
export function harnessFromAlias(alias: string): HarnessName | undefined {
  return Object.values(harnessDrivers).find((driver) => driver.aliases.includes(alias))?.profile.id;
}
