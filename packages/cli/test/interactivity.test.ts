import { assert, it } from "vitest";
import { promptsAllowed } from "../src/presentation/interactivity.js";

const terminal = { stdin: true, stdout: true, stderr: true };

it("prompts only for a person at a terminal", () => {
  assert.isTrue(promptsAllowed({ json: false, streams: terminal, env: {} }));
  assert.isFalse(promptsAllowed({ json: true, streams: terminal, env: {} }));
  assert.isFalse(promptsAllowed({ json: false, streams: { ...terminal, stdin: false }, env: {} }));
  assert.isTrue(promptsAllowed({ json: false, streams: { ...terminal, stdout: false }, env: {} }));
  assert.isFalse(
    promptsAllowed({
      json: false,
      needsStdout: true,
      streams: { ...terminal, stdout: false },
      env: {},
    }),
  );
});

// Codex runs commands in a pseudo-terminal, so every stream is a terminal while an agent answers.
it("never prompts when an agent or automation drives the terminal", () => {
  for (const env of [
    { CODEX_CI: "1" },
    { CODEX_THREAD_ID: "019a" },
    { CLAUDECODE: "1" },
    { AI_AGENT: "some-agent" },
    { CI: "true" },
    { SKIT_NO_INPUT: "1" },
  ])
    assert.isFalse(promptsAllowed({ json: false, streams: terminal, env }), JSON.stringify(env));
  for (const env of [{ CI: "false" }, { CI: "0" }, { SKIT_NO_INPUT: "" }])
    assert.isTrue(promptsAllowed({ json: false, streams: terminal, env }), JSON.stringify(env));
});
