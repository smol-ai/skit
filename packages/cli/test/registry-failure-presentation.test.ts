import { expect, test } from "vitest";
import { Schema } from "effect";
import * as Registry from "../src/registry/failures.js";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { Block, renderBlocks } from "../src/terminal/blocks.js";

const cases = {
  RegistryUnreachable: new Registry.RegistryUnreachable({
    origin: "https://registry.test",
    cause: new Error("connection reset"),
  }),
  RegistryOriginInvalid: new Registry.RegistryOriginInvalid({ origin: "bad-origin" }),
  NoStoredCredentials: new Registry.NoStoredCredentials(),
  RegistrySelectionAmbiguous: new Registry.RegistrySelectionAmbiguous({
    origins: ["https://one.test", "https://two.test"],
    command: "skit auth logout <origin-or-alias>",
  }),
  TooManyAuthAttempts: new Registry.TooManyAuthAttempts(),
  SignInFailed: new Registry.SignInFailed({
    origin: "https://registry.test",
    reason: {
      _tag: "RequestFailed",
      operation: "credential-create",
      status: 403,
      registryCode: "forbidden",
    },
  }),
  SignOutRejected: new Registry.SignOutRejected({
    origin: "https://registry.test",
    reason: { _tag: "ResponseRejected", status: 503 },
  }),
  RegistryAliasInvalid: new Registry.RegistryAliasInvalid({ alias: "Not valid" }),
  RegistryAliasConflict: new Registry.RegistryAliasConflict({ alias: "work" }),
  RegistryAliasNotFound: new Registry.RegistryAliasNotFound({ alias: "missing" }),
  RegistrySelectionConflict: new Registry.RegistrySelectionConflict({
    locator: "skit://registry.test/team/review",
  }),
  RegistrySelectionRequiresRegistrySource: new Registry.RegistrySelectionRequiresRegistrySource({
    source: "/work/review",
  }),
  RemoteSkitUnavailable: new Registry.RemoteSkitUnavailable({ identity: "team/review" }),
  LibraryChangedOnServer: new Registry.LibraryChangedOnServer(),
  AuthenticationRequired: new Registry.AuthenticationRequired({
    origin: "https://registry.test",
    scopes: "library:sync",
  }),
  CredentialLacksScope: new Registry.CredentialLacksScope({
    scope: "authoring:write",
    origin: "https://registry.test",
  }),
  PrincipalNotAuthorized: new Registry.PrincipalNotAuthorized({ action: "publish this SKIT" }),
  CredentialsUnusable: new Registry.CredentialsUnusable({
    path: "/home/owner/.skit/auth.json",
    reason: "unreadable",
  }),
  SignInRejected: new Registry.SignInRejected({ operation: "sign-in" }),
  InteractiveLoginUnavailable: new Registry.InteractiveLoginUnavailable(),
  DeviceLoginUnavailable: new Registry.DeviceLoginUnavailable({ origin: "https://registry.test" }),
  DeviceLoginEnded: new Registry.DeviceLoginEnded({ reason: "expired" }),
  ScopesInvalid: new Registry.ScopesInvalid({ allowed: ["library:sync", "authoring:write"] }),
  AuthorSyncRequired: new Registry.AuthorSyncRequired({ root: "/work/review" }),
  RegistryRejectedWrite: new Registry.RegistryRejectedWrite({
    origin: "https://registry.test",
    status: 409,
    registryCode: "release_conflict",
    failure: new Error("HTTP 409"),
  }),
  DeleteRequiresPrivate: new Registry.DeleteRequiresPrivate(),
} satisfies {
  [K in Registry.RegistryFailure["_tag"]]: Extract<Registry.RegistryFailure, { _tag: K }>;
};

test.each(Object.entries(cases))(
  "%s retains its facts through the codec and has an owner presentation",
  (_, failure) => {
    const codec = Schema.toCodecJson(Registry.RegistryFailure);
    const wire = Schema.encodeSync(codec)(failure);
    expect(wire).not.toHaveProperty("remediation");
    const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(wire)));
    expect(decoded._tag).toBe(failure._tag);
    expect(decoded.code).toBe(failure.code);
    const formatted = classifyFailure(decoded);
    expect(formatted.presentation[0]?._tag).toBe("Status");
    expect(formatted.presentation).toEqual(Registry.registryFailure(decoded).presentation);
    expect(formatted.next.length).toBeGreaterThan(0);
    expect(formatted.remediation).not.toBe("Check the reported failure and retry.");
  },
);

test("Registry choices and allowed scopes remain separate semantic items", () => {
  expect(classifyFailure(cases.RegistrySelectionAmbiguous).presentation).toEqual([
    Block.Status({ tone: "error", text: ["Registry selection is ambiguous"] }),
    Block.List({
      items: [{ text: [{ code: "https://one.test" }] }, { text: [{ code: "https://two.test" }] }],
    }),
    Block.Fields({
      rows: [
        {
          label: "Next",
          value: [
            "Run ",
            { code: "skit auth logout <origin-or-alias>" },
            " to choose one Registry.",
          ],
        },
      ],
    }),
  ]);
  expect(classifyFailure(cases.ScopesInvalid).presentation).toContainEqual(
    Block.List({
      items: [{ text: [{ code: "library:sync" }] }, { text: [{ code: "authoring:write" }] }],
    }),
  );
});

test("the transport keeps its native cause live and exposes its diagnostic separately", () => {
  const original = new Error("connection reset", { cause: new TypeError("native reason") });
  const failure = new Registry.RegistryUnreachable({
    origin: "https://registry.test",
    cause: original,
  });
  expect(failure.cause).toBe(original);
  expect(classifyFailure(failure).explanation).toEqual([
    Block.Status({
      tone: "error",
      text: ["Unable to reach Registry ", { code: "https://registry.test" }],
    }),
    Block.Note({ text: ["connection reset"] }),
  ]);
  expect(Schema.is(Registry.RegistryFailure)(original)).toBe(false);
});

test("shell paths and command text stay one code span, without interpreting literal backticks", () => {
  const failure = new Registry.AuthorSyncRequired({ root: "/work/Tim's `review` $(literal)" });
  const formatted = classifyFailure(failure);
  expect(formatted.next).toEqual([
    "Run ",
    { code: "skit author sync '/work/Tim'\\''s `review` $(literal)' --apply" },
    ", then publish again.",
  ]);
  const shown = renderBlocks(classifyFailure(cases.AuthenticationRequired).presentation, {
    color: false,
  });
  expect(shown).not.toContain("`");
  expect(shown).toContain("skit auth login 'https://registry.test' --scopes");
});

test.each(["denied", "expired", "invalid"] as const)(
  "browser login explains %s without guessing another condition",
  (reason) => {
    const formatted = classifyFailure(new Registry.DeviceLoginEnded({ reason }));
    const expected = {
      denied: "The login was denied in the browser",
      expired: "The login code expired before it was approved",
      invalid: "The login code is invalid or was already used",
    }[reason];
    expect(formatted.explanation).toEqual([Block.Status({ tone: "error", text: [expected] })]);
    expect(formatted.next).toEqual(["Run ", { code: "skit auth login" }, " again for a new code."]);
  },
);

test("an unreadable credential file does not imply that its contents are invalid", () => {
  const unreadable = classifyFailure(cases.CredentialsUnusable);
  expect(unreadable.explanation).toEqual([
    Block.Status({
      tone: "error",
      text: [
        "Cannot read SKIT authentication configuration at ",
        { path: cases.CredentialsUnusable.path },
      ],
    }),
  ]);
  const invalid = classifyFailure(
    new Registry.CredentialsUnusable({ path: cases.CredentialsUnusable.path, reason: "invalid" }),
  );
  expect(invalid.next).toEqual([
    "Move ",
    { path: cases.CredentialsUnusable.path },
    " aside, then run ",
    { code: "skit auth login" },
    " again.",
  ]);
});
