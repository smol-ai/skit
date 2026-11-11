import { expect, test } from "vitest";
import { Cause, Schema } from "effect";
import { classifyFailure, commandFailure } from "../src/commands/failure-classification.js";
import { CommandError } from "../src/commands/error-output.js";
import { renderFailureFrame, defaultTerminalEnvironment } from "../src/commands/output-frame.js";
import { RegistrySelectionAmbiguous } from "../src/registry/failures.js";
import { Block } from "../src/terminal/blocks.js";

test("native causes explain a rendered command failure before and after JSON", () => {
  const error = new Error("Could not restore source", { cause: new Error("Credentials expired") });
  const original = Cause.die(error);
  const failure = commandFailure(original);
  expect(failure.cause).toBe(original);
  const frame = renderFailureFrame(failure, { ...defaultTerminalEnvironment, color: false });
  const data = JSON.parse(
    renderFailureFrame(failure, {
      ...defaultTerminalEnvironment,
      format: "json",
      color: false,
    }).stderr,
  ).error;
  expect(data.cause).toBeDefined();
  const restored = Schema.decodeUnknownSync(CommandError)(data);
  expect(commandFailure(restored.cause).presentation).toEqual(failure.presentation);
  expect(failure.presentation).toContainEqual(
    Block.Status({ tone: "error", text: ["Could not restore source"] }),
  );
  expect(failure.presentation).toContainEqual(
    Block.Group({
      title: "Caused by",
      children: [Block.Note({ text: ["Credentials expired"] })],
    }),
  );
  expect(frame.stdout).toBe("");
  expect(frame.exitCode).toBe(1);
  const encoded = Schema.encodeSync(CommandError)({ code: failure.code, cause: original });
  const decoded = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(encoded)));
  expect(commandFailure(decoded.cause).presentation).toEqual(failure.presentation);
});

test("repeated cause messages appear once without hiding a deeper explanation", () => {
  const error = new Error("Fetch failed", {
    cause: new Error("Fetch failed", {
      cause: new Error("Credentials expired"),
    }),
  });
  const failure = classifyFailure(error);
  expect(failure.message.match(/Fetch failed/g)).toHaveLength(1);
  expect(failure.message).toContain("Credentials expired");
});

test("native cause cycles terminate without repeating the outer error", () => {
  const outer = new Error("outer");
  const inner = new Error("inner", { cause: outer });
  outer.cause = inner;
  const failure = classifyFailure(outer);
  expect(failure.message.match(/outer/g)).toHaveLength(1);
  expect(failure.message.match(/inner/g)).toHaveLength(1);
});

test("deep native chains stop with an explicit omission notice", () => {
  let error = new Error("deepest");
  for (let depth = 0; depth < 10_000; depth++)
    error = new Error(`wrapper ${depth}`, { cause: error });
  const failure = classifyFailure(error);
  expect(failure.message).toContain("wrapper 9999");
  expect(failure.message).not.toContain("deepest");
  expect(failure.message).toContain("Further cause details omitted.");
});

test("a native wrapper uses a known child's explanation without adopting its action", () => {
  const child = new RegistrySelectionAmbiguous({
    origins: ["https://one.test", "https://two.test"],
    command: "skit auth logout",
  });
  const failure = classifyFailure(new Error("Source failed", { cause: child }));
  expect(failure.presentation).toContainEqual(
    Block.Group({ title: "Caused by", children: classifyFailure(child).explanation }),
  );
  expect(failure.remediation).toBe("Check the reported failure and retry.");
  expect(failure.presentation.filter((block) => block._tag === "Fields")).toHaveLength(1);
});

test("fallback accepts primitive causes and does not traverse arbitrary failure fields", () => {
  expect(classifyFailure(new Error("Request failed", { cause: "offline" })).message).toContain(
    "offline",
  );
  expect(classifyFailure({ message: "outer", failure: new Error("hidden") }).message).toBe("outer");
});
