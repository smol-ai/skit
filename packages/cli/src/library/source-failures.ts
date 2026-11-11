import { describeFailure } from "../terminal/failure.js";
import { SourceFailure } from "@smolai/skit-core/library/source/failures";
import { Match } from "effect";

export const sourceFailure = Match.type<SourceFailure>().pipe(
  Match.tagsExhaustive({
    RegistryNotConfigured: () =>
      describeFailure({
        summary: ["No SKIT Registry is configured."],
        next: [
          "Run ",
          { code: "skit auth login <registry-url>" },
          " to choose a Registry, or set SKIT_SERVER_URL. You can use the hosted Registry at ",
          { url: "https://skit.smol.ai" },
          " or self-host: ",
          { url: "https://github.com/smol-ai/skit/tree/main/packages/skit-server-effect" },
          ".",
        ],
      }),
    SourceRequired: () =>
      describeFailure({
        summary: ["SKIT source is required"],
        next: [
          "Pass a SKIT source, such as owner/repository, a local path, or an HTTPS or Git URL.",
        ],
      }),
    UnsafeSourceUrl: () =>
      describeFailure({
        summary: ["SKIT URL contains unsafe characters"],
        next: ["Remove whitespace and control characters from the SKIT URL, then retry."],
      }),
    InsecureSourceUrl: () =>
      describeFailure({
        summary: ["Remote SKIT URLs must use credential-free HTTPS"],
        next: ["Use an https:// URL without a username or password in it."],
      }),
    ArchiveEntryLimitExceeded: () =>
      describeFailure({
        summary: ["Archive contains too many entries"],
        next: ["Choose a smaller source; this archive has more entries than SKIT will unpack."],
      }),
    UnsafeArchivePath: (error) =>
      describeFailure({
        summary: [`Unsafe archive path: ${error.path}`],
        next: ["Choose a source whose archive entries stay inside its root."],
      }),
    SourceNotFound: (error) =>
      describeFailure({
        summary: [`Unknown or missing SKIT source: ${error.source}`],
        next: ["Check the source path or URL, then retry."],
      }),
    UnsafeGitSubpath: () =>
      describeFailure({
        summary: ["Git source subpath must be safe and relative"],
        next: ["Name a relative directory inside the repository, without ", { code: ".." }, "."],
      }),
    GitSourceFragment: (error) =>
      describeFailure({
        summary: [
          `Git source ${error.source} has a # fragment. A Git remote uses its default branch and root; on GitHub, use a tree URL (https://github.com/<owner>/<repository>/tree/<ref>/<path>) to select a ref or directory`,
        ],
        next: ["Remove the # fragment, or use a GitHub tree URL to select a ref or directory."],
      }),
    DirectSkillDocumentInvalid: () =>
      describeFailure({
        summary: ["Direct SKILL.md must be Markdown with name and description frontmatter"],
        next: ["Give the SKILL.md frontmatter a name and description, then retry."],
      }),
    NoSkitDescriptorFound: () =>
      describeFailure({
        summary: ["Source contains no valid SKIT README.md or Agent Skills SKILL.md"],
        next: ["Choose a source containing a SKILL.md or a SKIT README.md, then retry."],
      }),
  }),
);
