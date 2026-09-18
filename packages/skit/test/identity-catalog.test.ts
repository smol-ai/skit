import { describe, expect, test } from "vitest";
import {
  collectionDisplay,
  collectionIdentity,
  collectionRef,
  makeMachineId,
  portableCollectionIdentity,
  sourceIdentityEquals,
  sourceIdentityFromCollectionIdentity,
  skillRef,
} from "../src/index.js";
import {
  assertCollectionIdentityCatalog,
  collectionIdentityProfiles,
} from "../src/identity/profiles.js";

describe("Collection Identity catalog", () => {
  test("contains exactly one profile for every identity kind", () => {
    expect(() => assertCollectionIdentityCatalog()).not.toThrow();
    expect(() =>
      assertCollectionIdentityCatalog([
        ...collectionIdentityProfiles,
        collectionIdentityProfiles[0],
      ]),
    ).toThrow("Duplicate Collection Identity profile");
    expect(() => assertCollectionIdentityCatalog(collectionIdentityProfiles.slice(1))).toThrow(
      "Missing Collection Identity profile",
    );
  });

  test("gives descriptorless GitHub collections readable canonical references", () => {
    const identity = collectionIdentity({
      type: "git",
      ref: "https://github.com/MattPocock/skills.git#ref=main",
    });

    expect(identity).toEqual({
      profile: "github-collection",
      version: 1,
      owner: "mattpocock",
      repository: "skills",
      path: undefined,
    });
    expect(collectionRef(identity)).toBe("github:mattpocock/skills");
    expect(skillRef(identity, "code-review")).toBe("github:mattpocock/skills#code-review");
    expect(collectionDisplay(identity)).toBe("mattpocock/skills");
    expect(portableCollectionIdentity(identity)).toBe(true);
  });
  test("distinguishes selected GitHub Skill sets while ignoring the tracking ref", () => {
    const one = collectionIdentity({
      type: "git",
      ref: "https://github.com/acme/skills.git#ref=main&skill=skills%2Freview%2FSKILL.md",
    });
    const another = collectionIdentity({
      type: "git",
      ref: "https://github.com/acme/skills.git#ref=next&skill=skills%2Ftdd%2FSKILL.md",
    });
    expect(collectionRef(one)).toBe("github:acme/skills?skill=skills%2Freview%2FSKILL.md");
    expect(collectionRef(another)).toBe("github:acme/skills?skill=skills%2Ftdd%2FSKILL.md");
    expect(collectionRef(one)).not.toBe(collectionRef(another));
    const two = collectionIdentity({
      type: "git",
      ref: "https://github.com/acme/skills.git#skill=skills%2Freview%2FSKILL.md&skill=skills%2Ftdd%2FSKILL.md",
    });
    expect(collectionRef(two)).toBe(
      "github:acme/skills?skill=skills%2Freview%2FSKILL.md&skill=skills%2Ftdd%2FSKILL.md",
    );
    const subpath = collectionIdentity({
      type: "git",
      ref: "https://github.com/acme/skills.git#path=public%20skills",
    });
    expect(collectionRef(subpath)).toBe("github:acme/skills?path=public%20skills");
  });

  test("keeps collection subpaths while excluding Git revisions", () => {
    const identity = collectionIdentity({
      type: "git",
      ref: "git@github.com:example-org/skills.git#ref=next&path=collections/public",
    });

    expect(collectionRef(identity)).toBe("github:example-org/skills?path=collections%2Fpublic");
    expect(skillRef(identity, "review")).toBe(
      "github:example-org/skills?path=collections%2Fpublic#review",
    );
  });

  test("distinguishes declared SKIT identity from its acquisition source", () => {
    const identity = collectionIdentity(
      { type: "git", ref: "https://github.com/tim/tools.git" },
      { skitId: "tim/tools", authority: "https://skills.example.com" },
    );

    expect(collectionRef(identity)).toBe("skit:https://skills.example.com/tim/tools");
    expect(skillRef(identity, "review")).toBe("skit:https://skills.example.com/tim/tools#review");
  });

  test("marks local collection identity as device-local", () => {
    const identity = collectionIdentity({ type: "local", ref: "/tmp/private-skills" });
    expect(collectionRef(identity)).toBe("local:/tmp/private-skills");
    expect(portableCollectionIdentity(identity)).toBe(false);
  });

  test("gives Author Workspaces opaque device-local references and readable labels", () => {
    const identity = {
      profile: "authored-workspace" as const,
      version: 1 as const,
      workspaceId: "workspace_0123456789abcdef0123456789abcdef",
      slug: "my-tools",
    };
    expect(collectionRef(identity)).toBe("authored:workspace_0123456789abcdef0123456789abcdef");
    expect(collectionDisplay(identity)).toBe("my-tools");
    expect(portableCollectionIdentity(identity)).toBe(false);
  });

  test("gives raw GitHub Skill URLs a readable collection label", () => {
    const identity = collectionIdentity({
      type: "url",
      ref: "https://raw.githubusercontent.com/cursor/plugins/main/skills/review/SKILL.md",
    });

    expect(collectionDisplay(identity)).toBe("cursor/plugins");
    expect(collectionRef(identity)).toBe(
      "url:https://raw.githubusercontent.com/cursor/plugins/main/skills/review/SKILL.md",
    );
  });

  test("maps Collection Identity to one portable Source Identity model", () => {
    const machineId = makeMachineId();
    expect(
      sourceIdentityFromCollectionIdentity(
        {
          profile: "private-collection",
          version: 1,
          namespace: "tim",
          slug: "skills",
        },
        machineId,
        "private:tim/skills",
      ),
    ).toEqual({ kind: "registry", authority: "private", namespace: "tim", slug: "skills" });
    expect(
      sourceIdentityFromCollectionIdentity(
        { profile: "declared-skit", version: 1, skitId: "tim/skills" },
        machineId,
        "tim/skills",
      ),
    ).toEqual({ kind: "registry", authority: "default", namespace: "tim", slug: "skills" });
  });

  test("compares Source Identity structurally without device-local machine identity", () => {
    expect(
      sourceIdentityEquals(
        { kind: "local", machine_id: makeMachineId(), path: { value: "/skills" } },
        { kind: "local", machine_id: makeMachineId(), path: { value: "/skills" } },
      ),
    ).toBe(true);
    expect(
      sourceIdentityEquals(
        { kind: "url", url: { value: "https://skills.example.test" } },
        { kind: "well-known", locator: { value: "https://skills.example.test" } },
      ),
    ).toBe(true);
  });
});
