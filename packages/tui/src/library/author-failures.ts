import { publicationDiagnostic } from "./validation-diagnostic";
import { AuthorFailure } from "@smolai/skit-core/author/failures";
import { Match } from "effect";

export const authorFailure = Match.type<AuthorFailure>().pipe(
  Match.tagsExhaustive({
    AuthorDestinationRequired: ({ visibilityRequired }) => ({
      message: "This Author Workspace needs a destination for its first sync",
      remediation: `Choose the destination Namespace and SKIT${visibilityRequired ? ", and its visibility" : ""}, then retry.`,
    }),
    AuthorWorkspaceMetadataInvalid: (error) => ({
      message: `Invalid Author Workspace metadata at ${error.path}`,
      remediation: `Correct or remove the Author Workspace metadata at ${error.path}, then retry.`,
    }),
    AuthorWorkspaceAlreadyRegistered: (error) => ({
      message: `Author Workspace ${error.workspaceId} is already registered at ${error.at}`,
      remediation: `Use the existing workspace at ${error.at}. If this folder is a copy, remove .skit/workspace.json only in the copy, then register it again for a new identity.`,
    }),
    InsecureOrigin: (error) => ({
      message:
        error.purpose === "authentication"
          ? "Authentication requires HTTPS outside localhost"
          : "Author remotes require HTTPS outside localhost",
      remediation: "Use an https:// origin, or http://localhost for local development.",
    }),
    AuthorDestinationInvalid: (error) => ({
      message:
        error.form === "bare"
          ? "Author destination must be namespace/skit"
          : "HTTPS SKIT destination must end in /namespace/skit",
      remediation: "Pass the destination as namespace/skit or https://<registry>/namespace/skit.",
    }),
    AuthorDestinationMalformed: (error) => ({
      message: error.kind === "url" ? "Invalid URL" : "URI malformed",
      remediation: "Pass the destination as namespace/skit or https://<registry>/namespace/skit.",
    }),
    AuthorRemoteMetadataInvalid: (error) => ({
      message: `Author remote metadata at ${error.path} is invalid`,
      remediation: `Correct or remove the author remote metadata at ${error.path}, then retry.`,
    }),
    LocalFilesChangedDuringSync: () => ({
      message: "Local files changed while sync was running",
      remediation: "Let local edits finish, then sync again.",
    }),
    AuthorLocalPathUnchecked: (error) => ({
      message: `Cannot replace local path outside the recorded Author inventory: ${error.path}`,
      remediation:
        "SKIT kept this local path unchanged. Review its ignore rules or move it explicitly before retrying.",
    }),
    AuthorNormalizationTwin: (error) => ({
      message: `Normalization twin prevents receiving ${error.path}: ${error.nativePath}`,
      remediation: "Keep both files and give them distinct normalized names before retrying.",
    }),
    AuthorNonNfcPathUnsupported: (error) => ({
      message: `Receiving a non-NFC native path is unsupported on this filesystem: ${error.nativePath}`,
      remediation: "Rename the local path to NFC deliberately before receiving updates.",
    }),
    NotAnAuthorWorkspace: (error) => ({
      message: `${error.path} is not an Author Workspace; generate invocation metadata in its author-owned source directory`,
      remediation:
        "Run the command in an Author Workspace, the source directory you author a SKIT in.",
    }),
    AuthorRemoteAlreadyExists: (error) => ({
      message: `Remote home already exists at ${error.locator}`,
      remediation: "Sync without --to to use the existing remote home.",
    }),
    VisibilityNotAccepted: (error) => ({
      message:
        error.reason === "already-synced"
          ? "--visibility is accepted only on first author sync"
          : "First author sync requires --visibility",
      remediation:
        error.reason === "already-synced"
          ? "Sync again without --visibility."
          : "Pass --visibility private, unlisted or public.",
    }),
    DestinationFormInvalid: (error) => ({
      message:
        error.form === "canonical"
          ? "Canonical SKIT destination must be skit://host/namespace/skit"
          : "A relative author destination requires an active Registry; run `skit auth login`",
      remediation:
        error.form === "canonical"
          ? "Pass the destination as skit://host/namespace/skit."
          : "Run `skit auth login`, or pass a full destination.",
    }),
    DestinationExistsWithoutHistory: (error) => ({
      message: `Destination ${error.identity} already exists without common history`,
      remediation: "Choose a new destination, or sync from a SKIT that shares its history.",
    }),
    DirectoryAlreadyInLibrary: (error) => ({
      message: `This directory is already in the Library as ${error.collectionId}; remove it before registering an Author Workspace`,
      remediation: `Run \`skit remove ${error.collectionId}\`, then register the Author Workspace.`,
    }),
    NoRemoteHome: () => ({
      message: "This SKIT has no remote home; run `skit author sync --to ...` first",
      remediation: "Run `skit author sync --to <namespace/skit>` first.",
    }),
    PublicationBlocked: (error) => ({
      message:
        error.reason === "content"
          ? `This SKIT cannot be published as it stands:\n${error.diagnostics.map((item) => `  ${publicationDiagnostic(item)}`).join("\n")}`
          : `Publication is blocked by the current SKIT assessment${error.diagnostics.length ? `:\n${error.diagnostics.map(publicationDiagnostic).join("\n")}` : ""}`,
      remediation: "Resolve the reported findings, sync the SKIT, then publish again.",
    }),
    AuthorListIdentityError: ({ identity }) => ({
      message: `Registry returned invalid SKIT identity: ${identity}`,
      remediation: "Report the invalid identity to the Registry's operator.",
    }),
  }),
);
