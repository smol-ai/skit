import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { Schema } from "effect";
import * as Bootstrap from "../src/registry/bootstrap-failures.js";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { Block, renderBlocks } from "../src/terminal/blocks.js";

const target = {
  configPath: "/home/reviewer/worker's files/wrangler.jsonc",
  environment: "preview west",
};
const processFailure = (operation: Bootstrap.BootstrapExternalFailure["operation"]) =>
  new Bootstrap.BootstrapExternalFailure({
    operation,
    reason: {
      _tag: "ProcessFailed",
      command: "/opt/tools/wrangler",
      exitCode: 1,
      output: "Not logged in\n  authentication refused",
    },
  });
const failures = {
  BootstrapOriginInvalid: new Bootstrap.BootstrapOriginInvalid({ origin: "bad origin" }),
  BootstrapConfigInvalid: new Bootstrap.BootstrapConfigInvalid({
    target,
    reason: { _tag: "EnvironmentRequired", environments: ["preview west"] },
  }),
  BootstrapExternalFailure: processFailure("install-secret"),
  BootstrapStatusInvalid: new Bootstrap.BootstrapStatusInvalid({
    origin: "https://server.test",
    failure: new Error("body read failed"),
  }),
  BootstrapTimedOut: new Bootstrap.BootstrapTimedOut({
    origin: "https://server.test",
    timeoutMs: 1234,
  }),
  BootstrapCleanupFailed: new Bootstrap.BootstrapCleanupFailed({
    target,
    command: "/opt/wrangler tools/wrangler",
    cleanup: processFailure("remove-secret"),
    original: processFailure("install-secret"),
  }),
} satisfies {
  [K in Bootstrap.BootstrapFailure["_tag"]]: Extract<Bootstrap.BootstrapFailure, { _tag: K }>;
};

test.each(Object.values(failures))(
  "$_tag retains facts through its codec and reaches its formatter",
  (failure) => {
    const wire = Schema.encodeSync(Bootstrap.BootstrapFailure)(failure);
    const decoded = Schema.decodeUnknownSync(Bootstrap.BootstrapFailure)(
      JSON.parse(JSON.stringify(wire)),
    );
    expect(decoded._tag).toBe(failure._tag);
    expect(wire).not.toHaveProperty("message");
    expect(wire).not.toHaveProperty("remediation");
    expect(classifyFailure(decoded).presentation).toEqual(
      Bootstrap.bootstrapFailure(failure).presentation,
    );
  },
);

test("cleanup explains both failures with verbatim output and one action", () => {
  const description = Bootstrap.bootstrapFailure(failures.BootstrapCleanupFailed);
  const groups = description.explanation.filter((block) => block._tag === "Group");
  expect(groups.map((group) => group.title)).toEqual(["Setup failed", "Cleanup failed"]);
  for (const group of groups)
    expect(group.children).toContainEqual(
      Block.Verbatim({ text: "Not logged in\n  authentication refused" }),
    );
  expect(description.presentation.filter((block) => block._tag === "Fields")).toEqual([
    Block.Fields({ rows: [{ label: "Next", value: description.next }] }),
  ]);
  expect(description.next[0]).toBe("If the secret was installed, remove it with ");
});

test("the displayed removal command preserves the executable, config path and environment as arguments", () => {
  const description = Bootstrap.bootstrapFailure(failures.BootstrapCleanupFailed);
  const command = description.next.find((part) => typeof part !== "string" && "code" in part);
  if (typeof command !== "object" || !("code" in command))
    throw new Error("Missing cleanup command");
  // Read the shell's arguments without invoking Wrangler or touching a Worker.
  const recorded = execFileSync("/bin/sh", ["-c", `set -- ${command.code}; printf '%s\\0' "$@"`], {
    encoding: "utf8",
  })
    .split("\0")
    .slice(0, -1);
  expect(recorded).toEqual([
    failures.BootstrapCleanupFailed.command,
    ...Bootstrap.removeBootstrapSecretInvocation(target).args,
  ]);
  expect(
    renderBlocks(description.presentation, { color: false, home: "/home/reviewer" }),
  ).toContain(command.code);
});

test("native process causes remain live until encoding", () => {
  const cause = new Error("spawn unavailable", { cause: new Error("permission denied") });
  const failure = new Bootstrap.BootstrapExternalFailure({
    operation: "open-browser",
    reason: { _tag: "NativeFailure", failure: cause },
  });
  expect(failure.reason._tag === "NativeFailure" && failure.reason.failure).toBe(cause);
  expect(Bootstrap.bootstrapFailure(failure).next).toContain(
    "Check that the system browser can open URLs, then run ",
  );
});
