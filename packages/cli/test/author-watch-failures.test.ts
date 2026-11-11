import { expect, it } from "vitest";
import { Schema } from "effect";
import { AuthorWatchEvent } from "@smolai/skit-core/author";
import { AuthorHistoryInvalid } from "@smolai/skit-core/author/history-failures";
import { result } from "../src/commands/result.js";
import { renderContract } from "../src/commands/output-presenters.js";
import { RegistryUnreachable } from "../src/registry/failures.js";
import { AuthorWatchOutput } from "../src/author/watch-output.js";
import { Block } from "../src/terminal/blocks.js";
import { CredentialLacksScope, registryFailure } from "../src/registry/failures.js";
import { presentContract } from "../src/commands/output-presenters.js";

it("keeps a Registry transport failure structured through the CLI watcher boundary", () => {
  const cause = new Error("connection refused");
  const failure = new RegistryUnreachable({ origin: "https://registry.test", cause });
  const output = result("authorWatch", { event: "retrying", operation: "sync", failure });
  expect(output.data.event === "retrying" && output.data.failure).toBe(failure);
  expect(failure.cause).toBe(cause);
  const wire = JSON.parse(JSON.stringify(output.encodedData));
  expect(wire.failure).toMatchObject({
    _tag: "RegistryUnreachable",
    origin: "https://registry.test",
    cause: { message: "connection refused" },
  });
  expect(wire.failure).not.toHaveProperty("message");
  expect(wire.failure).not.toHaveProperty("remediation");
  const decoded = Schema.decodeUnknownSync(AuthorWatchOutput)(wire);
  const text = renderContract(result("authorWatch", decoded), { color: false, detail: "full" });
  expect(text).toContain("https://registry.test");
  expect(text).toContain("connection refused");
});

it("preserves Registry scope facts and a semantic login action after watcher JSON", () => {
  const failure = new CredentialLacksScope({
    scope: "authoring:write",
    origin: "https://registry.test",
  });
  const output = result("authorWatch", { event: "retrying", operation: "sync", failure });
  const wire = JSON.parse(JSON.stringify(output.encodedData));
  expect(wire.failure).toEqual({
    _tag: "CredentialLacksScope",
    scope: "authoring:write",
    origin: "https://registry.test",
  });
  const decoded = Schema.decodeUnknownSync(AuthorWatchOutput)(wire);
  const blocks = presentContract(result("authorWatch", decoded), { color: false, detail: "full" });
  expect(blocks).toContainEqual(
    Block.Group({ title: "Reason", children: registryFailure(failure).explanation }),
  );
  expect(blocks).toContainEqual(
    Block.Fields({ rows: [{ label: "Next", value: registryFailure(failure).next }] }),
  );
});

it("does not construct a different checked cause when a native watcher event is made", () => {
  const failure = new Error("Registry offline");
  const made = AuthorWatchOutput.make({ event: "retrying", operation: "sync", failure });
  expect(made.event === "retrying" && made.failure).toBe(failure);
});

it("keeps watcher failure facts live and across JSON while the CLI supplies the words", () => {
  for (const actual of ["workspace-one", "workspace-two"]) {
    const failure = new AuthorHistoryInvalid({
      path: "/state/history/journal.sqlite",
      reason: { _tag: "JournalWorkspaceMismatch", expected: "review", actual },
    });
    const output = result("authorWatch", { event: "retrying", operation: "observe", failure });
    expect(output.data.event === "retrying" && output.data.failure).toBe(failure);
    const wire = JSON.parse(JSON.stringify(output.encodedData));
    expect(wire.failure.reason).toEqual(failure.reason);
    expect(wire.failure).not.toHaveProperty("message");
    expect(wire.failure).not.toHaveProperty("remediation");
    const decoded = Schema.decodeUnknownSync(AuthorWatchEvent)(wire);
    const text = renderContract(result("authorWatch", decoded), { color: false, detail: "full" });
    expect(text).toContain(actual);
    expect(text).toContain("review");
    expect(text).toContain("Retrying automatically");
  }
});

it("carries a native transport error without losing its message at the JSON boundary", () => {
  const failure = new Error("Registry is offline", { cause: new Error("connection refused") });
  const output = result("authorWatch", { event: "retrying", operation: "sync", failure });
  expect(output.data.event === "retrying" && output.data.failure).toBe(failure);
  const wire = JSON.parse(JSON.stringify(output.encodedData));
  expect(wire.failure.message).toBe("Registry is offline");
  expect(wire.failure.cause.message).toBe("connection refused");
  const decoded = Schema.decodeUnknownSync(AuthorWatchEvent)(wire);
  const text = renderContract(result("authorWatch", decoded), { color: false, detail: "full" });
  expect(text).toContain("Registry is offline");
});
