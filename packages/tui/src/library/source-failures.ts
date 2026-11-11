import { SourceFailure } from "@smolai/skit-core/library/source/failures";
import { Match } from "effect";

export const sourceFailure = Match.type<SourceFailure>().pipe(
  Match.tagsExhaustive({
    RegistryNotConfigured: () => ({
      message: "No SKIT Registry is configured.",
      remediation:
        "Choose a Registry URL. You can use https://skit.smol.ai or a self-hosted Registry.",
    }),
    SourceRequired: () => ({
      message: "SKIT source is required",
      remediation:
        "Pass a SKIT source, such as owner/repository, a local path, or an HTTPS or Git URL.",
    }),
    UnsafeSourceUrl: () => ({
      message: "SKIT URL contains unsafe characters",
      remediation: "Remove whitespace and control characters from the SKIT URL, then retry.",
    }),
    InsecureSourceUrl: () => ({
      message: "Remote SKIT URLs must use credential-free HTTPS",
      remediation: "Use an https:// URL without a username or password in it.",
    }),
    ArchiveEntryLimitExceeded: () => ({
      message: "Archive contains too many entries",
      remediation: "Choose a smaller source; this archive has more entries than SKIT will unpack.",
    }),
    UnsafeArchivePath: (error) => ({
      message: `Unsafe archive path: ${error.path}`,
      remediation: "Choose a source whose archive entries stay inside its root.",
    }),
    SourceNotFound: (error) => ({
      message: `Unknown or missing SKIT source: ${error.source}`,
      remediation: "Check the source path or URL, then retry.",
    }),
    UnsafeGitSubpath: () => ({
      message: "Git source subpath must be safe and relative",
      remediation: "Name a relative directory inside the repository, without `..`.",
    }),
    GitSourceFragment: (error) => ({
      message: `Git source ${error.source} has a # fragment. A Git remote uses its default branch and root; on GitHub, use a tree URL (https://github.com/<owner>/<repository>/tree/<ref>/<path>) to select a ref or directory`,
      remediation: "Remove the # fragment, or use a GitHub tree URL to select a ref or directory.",
    }),
    DirectSkillDocumentInvalid: () => ({
      message: "Direct SKILL.md must be Markdown with name and description frontmatter",
      remediation: "Give the SKILL.md frontmatter a name and description, then retry.",
    }),
    NoSkitDescriptorFound: () => ({
      message: "Source contains no valid SKIT README.md or Agent Skills SKILL.md",
      remediation: "Choose a source containing a SKILL.md or a SKIT README.md, then retry.",
    }),
  }),
);
