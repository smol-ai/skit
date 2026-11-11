import { expect, test } from "vitest";
import { Schema } from "effect";
import { DescriptorMalformed, ReadmeFrontmatterMissing } from "../src/artifact/failures.js";
import { DirectSkillDocumentInvalid, NoSkitDescriptorFound } from "../src/sources/failures.js";
import { InstalledSkillFileMissing } from "../src/installed-skills/failures.js";
import { HarnessMetadataInvalid } from "../src/harnesses/metadata-failures.js";
import { isSkitFailure } from "../src/shared/failure.js";

test("missing installed files supply validation facts without frontend words", () => {
  const failure = new InstalledSkillFileMissing({ path: "/skills/review/SKILL.md" });
  expect(isSkitFailure(failure)).toBe(true);
  expect(failure.code).toBe("VALIDATION_FAILED");
  expect(Schema.encodeSync(InstalledSkillFileMissing)(failure)).toEqual({
    _tag: "InstalledSkillFileMissing",
    path: "/skills/review/SKILL.md",
  });
});

for (const [codec, failure] of [
  [DirectSkillDocumentInvalid, new DirectSkillDocumentInvalid()],
  [NoSkitDescriptorFound, new NoSkitDescriptorFound()],
  [ReadmeFrontmatterMissing, new ReadmeFrontmatterMissing()],
  [
    DescriptorMalformed,
    new DescriptorMalformed({ format: "json", issue: { _tag: "JsonSyntax", offset: 1 } }),
  ],
  [
    HarnessMetadataInvalid,
    new HarnessMetadataInvalid({ path: "/skills/review/SKILL.md", kind: "SKILL.md frontmatter" }),
  ],
] as const)
  test(`${failure._tag} supplies validation facts without frontend words`, () => {
    expect(isSkitFailure(failure)).toBe(true);
    expect(failure.code).toBe("VALIDATION_FAILED");
    const encoded = Schema.encodeUnknownSync(codec)(failure);
    expect(encoded).not.toHaveProperty("message");
    expect(encoded).not.toHaveProperty("remediation");
  });
