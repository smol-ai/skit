import { Data } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

// -- Sources ----------------------------------------------------------------------------------

export class SourceRequired extends Data.TaggedError("SourceRequired")<{}> implements SkitFailure {
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Pass a SKIT source, such as owner/repository, a local path, or an HTTPS or Git URL.";
  get message(): string {
    return "SKIT source is required";
  }
}

export class UnsafeSourceUrl
  extends Data.TaggedError("UnsafeSourceUrl")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Remove whitespace and control characters from the SKIT URL, then retry.";
  get message(): string {
    return "SKIT URL contains unsafe characters";
  }
}

export class InsecureSourceUrl
  extends Data.TaggedError("InsecureSourceUrl")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Use an https:// URL without a username or password in it.";
  get message(): string {
    return "Remote SKIT URLs must use credential-free HTTPS";
  }
}

export class ArchiveEntryLimitExceeded
  extends Data.TaggedError("ArchiveEntryLimitExceeded")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation =
    "Choose a smaller source; this archive has more entries than SKIT will unpack.";
  get message(): string {
    return "Archive contains too many entries";
  }
}

export class UnsafeArchivePath
  extends Data.TaggedError("UnsafeArchivePath")<{ path: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Choose a source whose archive entries stay inside its root.";
  get message(): string {
    return `Unsafe archive path: ${this.path}`;
  }
}

export class SourceNotFound
  extends Data.TaggedError("SourceNotFound")<{ source: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Check the source path or URL, then retry.";
  get message(): string {
    return `Unknown or missing SKIT source: ${this.source}`;
  }
}

export class UnsafeGitSubpath
  extends Data.TaggedError("UnsafeGitSubpath")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Name a relative directory inside the repository, without `..`.";
  get message(): string {
    return "Git source subpath must be safe and relative";
  }
}

export class GitSourceFragment
  extends Data.TaggedError("GitSourceFragment")<{ source: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Remove the # fragment, or use a GitHub tree URL to select a ref or directory.";
  get message(): string {
    return `Git source ${this.source} has a # fragment. A Git remote is acquired from its default branch and root; on GitHub, use a tree URL (https://github.com/<owner>/<repository>/tree/<ref>/<path>) to select a ref or directory`;
  }
}

export class DirectSkillDocumentInvalid
  extends Data.TaggedError("DirectSkillDocumentInvalid")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Give the SKILL.md frontmatter a name and description, then retry.";
  get message(): string {
    return "Direct SKILL.md must be Markdown with name and description frontmatter";
  }
}

export class NoSkitDescriptorFound
  extends Data.TaggedError("NoSkitDescriptorFound")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Choose a source containing a SKILL.md or a SKIT README.md, then retry.";
  get message(): string {
    return "Source contains no valid SKIT README.md or Agent Skills SKILL.md";
  }
}
