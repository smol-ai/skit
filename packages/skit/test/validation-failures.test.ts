import { expect, test } from "vitest";
import { DescriptorMalformed, ReadmeFrontmatterMissing } from "../src/artifact/failures.js";
import { DirectSkillDocumentInvalid, NoSkitDescriptorFound } from "../src/sources/failures.js";
import { InstalledSkillFileMissing } from "../src/installed-skills/failures.js";
import { HarnessMetadataInvalid } from "../src/harnesses/metadata-failures.js";
import { InvalidLibraryState } from "../src/library/failures.js";
import { failureDetails, isSkitFailure } from "../src/shared/failure.js";

// Owners supply failure facts. Frontends independently map their shared code to an exit status.
for (const failure of [
  new ReadmeFrontmatterMissing(),
  new DescriptorMalformed({ format: "json", detail: "unexpected token" }),
  new DirectSkillDocumentInvalid(),
  new NoSkitDescriptorFound(),
  new InstalledSkillFileMissing({ path: "/skills/review/SKILL.md" }),
  new HarnessMetadataInvalid({ path: "/skills/review/SKILL.md", kind: "SKILL.md frontmatter" }),
  new InvalidLibraryState({ path: "/home/.skit/state.json", detail: "schema v2" }),
])
  test(`${failure._tag} supplies recognized validation facts and its own remediation`, () => {
    expect(isSkitFailure(failure)).toBe(true);
    expect(failureDetails(failure)).toEqual({
      code: "VALIDATION_FAILED",
      message: failure.message,
      remediation: failure.remediation,
    });
    expect(failure.remediation).not.toBe("");
    expect(failure.remediation).not.toContain("skit author");
  });
