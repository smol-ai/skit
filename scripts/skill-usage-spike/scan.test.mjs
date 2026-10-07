import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extract, readAttempts, scan } from "./scan.mjs";

test("Claude invocation, native injection, inventory and slash command are distinct", () => {
  const call = {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Skill", id: "call-1", input: { skill: "example" } }],
    },
  };
  assert.equal(extract("claude", call).uses[0].kind, "explicitToolInvocation");
  assert.equal(
    extract("claude", {
      type: "user",
      isMeta: true,
      message: { content: "Base directory for this skill: /synthetic/example\nInstructions" },
    }).uses[0].kind,
    "instructionInjection",
  );
  assert.equal(
    extract("claude", {
      type: "user",
      message: { content: "Base directory for this skill: /synthetic/example" },
    }).uses.length,
    0,
  );
  assert.equal(
    extract("claude", {
      type: "user",
      message: {
        content: "<command-message>example</command-message><command-name>/example</command-name>",
      },
    }).diagnostics.slashCommands,
    1,
  );
  assert.equal(extract("claude", { ...call, isCompactSummary: true }).uses.length, 0);
});

test("Codex only accepts anchored injected envelopes, not advertised inventory or summaries", () => {
  const text =
    "<skill>\n<name>example</name>\n<path>/synthetic/example/SKILL.md</path>\nInstructions\n</skill>";
  const r = {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
  assert.equal(extract("codex", r).uses[0].kind, "instructionInjection");
  assert.equal(
    extract("codex", { ...r, payload: { ...r.payload, role: "developer" } }).uses.length,
    0,
  );
  assert.equal(
    extract("codex", {
      ...r,
      payload: {
        ...r.payload,
        content: [{ type: "input_text", text: "Available skills: " + text }],
      },
    }).uses.length,
    0,
  );
  assert.equal(extract("codex", { type: "compacted", payload: r.payload }).uses.length, 0);
});

test("reads exclude mentions/search and accept literal code wrappers without executing them", () => {
  assert.deepEqual(readAttempts("exec_command", { cmd: "rg SKILL.md /synthetic" }), []);
  assert.deepEqual(readAttempts("exec_command", { cmd: "echo /synthetic/example/SKILL.md" }), []);
  assert.deepEqual(readAttempts("exec_command", { cmd: "cat /synthetic/example/SKILL.md" }), [
    "/synthetic/example/SKILL.md",
  ]);
  assert.deepEqual(readAttempts("Read", { file_path: "/synthetic/example/SKILL.md" }), [
    "/synthetic/example/SKILL.md",
  ]);
  const r = {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "c",
      input: 'text(await tools.exec_command({cmd:"cat /synthetic/example/SKILL.md"}));',
    },
  };
  assert.equal(extract("codex", r).uses[0].kind, "documentReadAttempt");
  assert.equal(
    extract("codex", {
      ...r,
      payload: { ...r.payload, input: "await tools.exec_command({cmd: dynamic}); // SKILL.md" },
    }).diagnostics.wrapperUnparsed,
    1,
  );
});

test("raw JSONL boundaries, replay, malformed/truncated, undated records and streaming parity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skit-usage-test-"));
  try {
    const start = Date.parse("2026-10-01T00:00:00Z");
    const end = start + 7 * 86400000;
    const call = (timestamp, id = "one") => ({
      timestamp,
      type: "assistant",
      uuid: id,
      message: { content: [{ type: "tool_use", name: "Skill", id, input: { skill: "example" } }] },
    });
    const records = [
      call(new Date(start).toISOString()),
      call(new Date(start).toISOString()),
      call(new Date(start - 1).toISOString(), "old"),
      call(new Date(end).toISOString(), "end"),
      call(undefined, "undated"),
      call("bad", "invalid"),
      [],
      {
        timestamp: new Date(start).toISOString(),
        type: "user",
        message: { content: "Available skill: example /synthetic/example/SKILL.md" },
      },
      call(new Date(start + 1).toISOString(), "two"),
    ];
    fs.mkdirSync(path.join(root, "subagents"));
    fs.writeFileSync(
      path.join(root, "one.jsonl"),
      records.map(JSON.stringify).join("\n") + '\n{malformed}\n{"unfinished":',
    );
    fs.writeFileSync(path.join(root, "subagents/two.jsonl"), JSON.stringify(records[0]));
    // Cross chunk boundary and valid non-newline-terminated record.
    fs.writeFileSync(
      path.join(root, "long.jsonl"),
      JSON.stringify({
        timestamp: new Date(start).toISOString(),
        type: "user",
        message: { content: "x".repeat(300000) },
      }),
    );
    const roots = [{ root, harness: "claude" }];
    const streamed = scan({ roots, start, end, mode: "stream" });
    const buffered = scan({ roots, start, end, mode: "buffer" });
    assert.deepEqual(streamed.counts, buffered.counts);
    const c = streamed.counts.claude;
    assert.equal(c.explicitToolInvocation, 2);
    assert.equal(c.duplicates, 2);
    assert.equal(c.undatedRecognized, 2);
    assert.equal(c.malformed, 2);
    assert.equal(c.malformedTrailing, 1);
    assert.equal(c.nonObject, 1);
    assert.equal(c.windowRecords, 6);
    assert.equal(c.subagentFiles, 1);
    assert.equal(streamed.timing.bytesRead, c.bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mtime filtering is optional and can lose restored historical files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skit-usage-mtime-"));
  try {
    const start = Date.parse("2026-10-01T00:00:00Z");
    const end = start + 7 * 86400000;
    const file = path.join(root, "restored.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({
        timestamp: new Date(start).toISOString(),
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", id: "restored-call", input: { skill: "example" } },
          ],
        },
      }),
    );
    fs.utimesSync(file, new Date(start - 86400000), new Date(start - 86400000));
    const roots = [{ root, harness: "claude" }];
    assert.equal(scan({ roots, start, end }).recognizedObservations, 1);
    assert.equal(scan({ roots, start, end, recentFiles: true }).recognizedObservations, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
