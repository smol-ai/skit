import { describeFailure } from "../terminal/failure.js";
import { publicationDiagnostic } from "../platform/validation-diagnostic.js";
import { AuthorFailure } from "@smolai/skit-core/author/failures";
import { Match } from "effect";
import { Block } from "../terminal/blocks.js";

export const authorFailure = Match.type<AuthorFailure>().pipe(
  Match.tagsExhaustive({
    AuthorDestinationRequired: ({ visibilityRequired }) =>
      describeFailure({
        summary: ["This Author Workspace needs a destination for its first sync"],
        next: [
          "Pass --to <namespace/skit>" +
            (visibilityRequired ? " and --visibility <private|unlisted|public>" : "") +
            ", then retry.",
        ],
      }),
    AuthorWorkspaceMetadataInvalid: (error) =>
      describeFailure({
        summary: [`Invalid Author Workspace metadata at ${error.path}`],
        next: [
          "Correct or remove the Author Workspace metadata at " + error.path + ", then retry.",
        ],
      }),
    AuthorWorkspaceAlreadyRegistered: (error) =>
      describeFailure({
        summary: [`Author Workspace ${error.workspaceId} is already registered at ${error.at}`],
        next: [
          "Use the existing workspace at " +
            error.at +
            ". If this folder is a copy, remove .skit/workspace.json only in the copy, then register it again for a new identity.",
        ],
      }),
    InsecureOrigin: (error) =>
      describeFailure({
        summary: [
          error.purpose === "authentication"
            ? "Authentication requires HTTPS outside localhost"
            : "Author remotes require HTTPS outside localhost",
        ],
        next: ["Use an https:// origin, or http://localhost for local development."],
      }),
    AuthorDestinationInvalid: (error) =>
      describeFailure({
        summary: [
          error.form === "bare"
            ? "Author destination must be namespace/skit"
            : "HTTPS SKIT destination must end in /namespace/skit",
        ],
        next: ["Pass the destination as namespace/skit or https://<registry>/namespace/skit."],
      }),
    AuthorDestinationMalformed: (error) =>
      describeFailure({
        summary: [error.kind === "url" ? "Invalid URL" : "URI malformed"],
        next: ["Pass the destination as namespace/skit or https://<registry>/namespace/skit."],
      }),
    AuthorRemoteMetadataInvalid: (error) =>
      describeFailure({
        summary: [`Author remote metadata at ${error.path} is invalid`],
        next: ["Correct or remove the author remote metadata at " + error.path + ", then retry."],
      }),
    LocalFilesChangedDuringSync: () =>
      describeFailure({
        summary: ["Local files changed while sync was running"],
        next: ["Let local edits finish, then sync again."],
      }),
    AuthorLocalPathUnchecked: (error) =>
      describeFailure({
        summary: [`Cannot replace local path outside the recorded Author inventory: ${error.path}`],
        next: [
          "SKIT kept this local path unchanged. Review its ignore rules or move it explicitly before retrying.",
        ],
      }),
    AuthorNormalizationTwin: (error) =>
      describeFailure({
        summary: [`Normalization twin prevents receiving ${error.path}: ${error.nativePath}`],
        next: ["Keep both files and give them distinct normalized names before retrying."],
      }),
    AuthorNonNfcPathUnsupported: (error) =>
      describeFailure({
        summary: [
          `Receiving a non-NFC native path is unsupported on this filesystem: ${error.nativePath}`,
        ],
        next: ["Rename the local path to NFC deliberately before receiving updates."],
      }),
    NotAnAuthorWorkspace: (error) =>
      describeFailure({
        summary: [
          `${error.path} is not an Author Workspace; generate invocation metadata in its author-owned source directory`,
        ],
        next: [
          "Run the command in an Author Workspace, the source directory you author a SKIT in.",
        ],
      }),
    AuthorRemoteAlreadyExists: (error) =>
      describeFailure({
        summary: [`Remote home already exists at ${error.locator}`],
        next: ["Sync without --to to use the existing remote home."],
      }),
    VisibilityNotAccepted: (error) =>
      describeFailure({
        summary: [
          error.reason === "already-synced"
            ? "--visibility is accepted only on first author sync"
            : "First author sync requires --visibility",
        ],
        next:
          error.reason === "already-synced"
            ? ["Sync again without --visibility."]
            : ["Pass --visibility private, unlisted or public."],
      }),
    DestinationFormInvalid: (error) =>
      describeFailure({
        summary: [
          error.form === "canonical"
            ? "Canonical SKIT destination must be skit://host/namespace/skit"
            : "A relative author destination requires an active Registry; run `skit auth login`",
        ],
        next:
          error.form === "canonical"
            ? ["Pass the destination as skit://host/namespace/skit."]
            : ["Run ", { code: "skit auth login" }, ", or pass a full destination."],
      }),
    DestinationExistsWithoutHistory: (error) =>
      describeFailure({
        summary: [`Destination ${error.identity} already exists without common history`],
        next: ["Choose a new destination, or sync from a SKIT that shares its history."],
      }),
    DirectoryAlreadyInLibrary: (error) =>
      describeFailure({
        summary: [
          `This directory is already in the Library as ${error.collectionId}; remove it before registering an Author Workspace`,
        ],
        next: [
          "Run ",
          { code: "skit remove " + error.collectionId },
          ", then register the Author Workspace.",
        ],
      }),
    NoRemoteHome: () =>
      describeFailure({
        summary: ["This SKIT has no remote home; run `skit author sync --to ...` first"],
        next: ["Run ", { code: "skit author sync --to <namespace/skit>" }, " first."],
      }),
    PublicationBlocked: (error) =>
      describeFailure({
        summary: [
          (error.reason === "content"
            ? "This SKIT cannot be published as it stands"
            : "Publication is blocked by the current SKIT assessment") +
            (error.diagnostics.length ? ":" : ""),
        ],
        details: error.diagnostics.length
          ? [
              Block.List({
                items: error.diagnostics.map((item) => ({
                  text: [publicationDiagnostic(item)],
                  ...(item.path === undefined ? {} : { detail: [{ code: item.path }] }),
                })),
              }),
            ]
          : [],
        next: ["Resolve the reported findings, sync the SKIT, then publish again."],
      }),
    AuthorListIdentityError: ({ identity }) =>
      describeFailure({
        summary: [`Registry returned invalid SKIT identity: ${identity}`],
        next: ["Report the invalid identity to the Registry's operator."],
      }),
  }),
);
