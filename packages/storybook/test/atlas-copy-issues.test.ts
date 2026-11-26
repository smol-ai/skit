import { stripVTControlCharacters } from "node:util";
import { expect, test } from "vitest";
import { copyIssues, markIssues } from "../src/atlas/copy-issues.ts";
import {
  defaultTerminalEnvironment,
  outputStories,
  renderOutputFrame,
} from "@smolai/skit/storybook";

const suffix = "0".repeat(26);
const operation = `op_${suffix}`;
const collection = `coll_${suffix}`;
const skill = `skill_${suffix}`;
const hash = `sha256:${"0".repeat(64)}`;

// These forms are emitted by setup/recovery actions, update retry, sync choices and bootstrap.
// Their selectors remain machine values because names alone cannot safely identify the choice.
test.each([
  `skit setup --apply ${hash}`,
  `skit setup --apply ${hash} --reviewed ${hash}`,
  `skit library undo ${operation}`,
  `skit library undo ${operation} --apply ${hash}`,
  `"skit" "library" "undo" "story-operation" "--apply" "${hash}" "--home" "/home/story/.skit" "--json"`,
  `skit library recovery inspect ${operation}`,
  `skit library recovery restore ${operation} --apply ${hash}`,
  `skit update ${collection}`,
  `skit update ${skill}`,
  `skit sync --apply --take-remote 'collection:${collection}'`,
  `skit sync --apply --take-remote 'skill:${skill}'`,
  `skit sync --apply --keep-enabled '${skill}'`,
  "wrangler secret delete SKIT_BOOTSTRAP_SECRET --config wrangler.jsonc",
  `"skit" "library" "undo" "${operation}" "--apply" "${hash}" "--home" "/home/story/.skit" "--json"`,
  `Next: Nothing was rolled back. Preview undoing it with skit library undo ${operation}, or run skit setup again.`,
  `Apply it without prompts: skit setup\n  --apply ${hash} --work-dir /home/story/work`,
])("allows required literal arguments in %s", (command) => {
  expect(copyIssues(command)).toEqual([]);
});

test.each([
  `Skill ${skill} is missing`,
  `Saved revision ${hash}`,
  "Cleanup failed for SKIT_BOOTSTRAP_SECRET",
  `Unknown command: skit explain ${skill}`,
  `skit setup --name ${hash}`,
  `skit sync --apply --unknown ${skill}`,
  `skit sync --apply --keep-enabled ${collection}`,
  `skit library undo ${collection}`,
  `skit library undo '${operation}`,
  `skit update ${collection}/extra`,
  `not-skit update ${collection}`,
  `skit update "label with ${collection}"`,
  "wrangler secret put SKIT_BOOTSTRAP_SECRET",
])("still reports identifiers outside verified argument positions in %s", (text) => {
  expect(copyIssues(text).length).toBeGreaterThan(0);
});

test("an allowed command does not hide the same value printed as prose", () => {
  const text = `Skill ${skill} is missing.\nskit sync --apply --keep-enabled '${skill}'`;
  expect(copyIssues(text)).toEqual([{ kind: "ID", text: skill }]);
  expect(copyIssues(text.split("\n").reverse().join("\n"))).toEqual([{ kind: "ID", text: skill }]);
});

test("marks only the prose occurrence while preserving ANSI styles and command bytes", () => {
  const command = `skit sync --apply --keep-enabled '${skill}'`;
  const ansi = `Skill \u001b[36m${skill}\u001b[39m is missing.\n\u001b[36m${command}\u001b[39m`;
  const issues = copyIssues(stripVTControlCharacters(ansi));
  const marked = markIssues(ansi, issues);
  expect(marked.match(/\u001b\[53m/g)).toHaveLength(1);
  expect(marked).toContain(`\u001b[36m\u001b[53m${skill}\u001b[55m\u001b[39m`);
  expect(marked).toContain(`\u001b[36m${command}\u001b[39m`);
  expect(stripVTControlCharacters(marked)).toBe(stripVTControlCharacters(ansi));
});

test("avoided verbs remain copy findings", () => {
  expect(copyIssues("Retired a binding")).toEqual([
    { kind: "term", text: "Retired", verb: "retire" },
    { kind: "term", text: "binding", verb: "bind" },
  ]);
});

test("the CLI story catalog has no unresolved copy findings under the approved command policy", () => {
  expect(outputStories.length).toBeGreaterThan(0);
  for (const [index, story] of outputStories.entries()) {
    for (const color of [false, true]) {
      const frame = renderOutputFrame(index, { ...defaultTerminalEnvironment, width: 88, color });
      if (frame === undefined) throw new Error(`Missing output frame for ${story.key}`);
      expect(copyIssues(stripVTControlCharacters(frame.stdout + frame.stderr)), story.key).toEqual(
        [],
      );
    }
  }
});
