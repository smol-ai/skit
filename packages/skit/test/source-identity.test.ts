import { describe, expect, test } from "vitest";
import { migratedMachineId } from "../src/library/entity-ids.js";
import {
  collectionLabelFromSource,
  sourceIdentityFromSource,
} from "../src/library/source-identity.js";

const machineId = migratedMachineId("019950c0-4c00-7000-8000-000000000001", "source-identity-test");

describe("source identity", () => {
  test("derives GitHub identity from the repository and collection root, not selection", () => {
    const source = {
      type: "git" as const,
      locator:
        "https://github.com/acme/skills.git#ref=main&path=public&skill=public%2Freview%2FSKILL.md",
    };
    expect(sourceIdentityFromSource(source, machineId)).toEqual({
      kind: "github",
      owner: "acme",
      repository: "skills",
      collection_root: "public",
    });
    expect(collectionLabelFromSource(source)).toBe("acme/skills/public");
  });

  test("derives registry identity and label from a declared source", () => {
    const source = {
      type: "registry" as const,
      locator: "tim/tools@1.2.3",
      authority: "https://skills.example.com",
    };
    expect(sourceIdentityFromSource(source, machineId)).toEqual({
      kind: "registry",
      authority: "https://skills.example.com",
      namespace: "tim",
      slug: "tools",
    });
    expect(collectionLabelFromSource(source)).toBe("tim/tools");
  });

  test("requires a machine identity for local source identity", () => {
    const source = { type: "local" as const, locator: "/tmp/private-skills" };
    expect(sourceIdentityFromSource(source, undefined)).toBeUndefined();
    expect(sourceIdentityFromSource(source, machineId)).toEqual({
      kind: "local",
      machine_id: machineId,
      path: { value: "/tmp/private-skills" },
    });
    expect(collectionLabelFromSource(source)).toBe("private-skills");
  });

  test("keeps well-known discovery distinct from direct URLs", () => {
    expect(
      sourceIdentityFromSource(
        { type: "well-known", locator: "https://skills.example.com" },
        machineId,
      ),
    ).toEqual({
      kind: "well-known",
      locator: { value: "https://skills.example.com" },
    });
  });
});
