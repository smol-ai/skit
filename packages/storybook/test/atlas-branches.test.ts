import { describe, expect, it } from "vitest";
import { branchFlows } from "../src/atlas/branches.ts";

const flow = (name: string, frames: string) => ({ name, frames: frames.split("") });

describe("branchFlows", () => {
  it("forks each flow from the earliest flow sharing the most leading frames", () => {
    const tree = branchFlows(
      [flow("pull", "abcd"), flow("other", "xy"), flow("fails", "abz"), flow("conflict", "aq")],
      (item) => item.frames,
    );
    expect(tree.map(({ flow, fork }) => [flow.name, fork])).toEqual([
      ["pull", undefined],
      ["fails", { parent: 0, at: 2 }],
      ["conflict", { parent: 0, at: 1 }],
      ["other", undefined],
    ]);
  });

  it("does not fork without a shared prefix or when a flow adds nothing", () => {
    const tree = branchFlows(
      [flow("a", "ab"), flow("b", "cd"), flow("c", "a")],
      (item) => item.frames,
    );
    expect(tree.every(({ fork }) => fork === undefined)).toBe(true);
  });
});

it("only shares scenario prefixes when the declared starting worlds are equal", () => {
  const online = { registryOnline: true, registered: ["a", "b"] };
  const tree = branchFlows(
    [
      { ...flow("online", "abc"), world: online, terminalDevice: "a" },
      { ...flow("offline", "abd"), world: { ...online, registryOnline: false } },
      {
        ...flow("same-world", "abe"),
        world: { registryOnline: true, registered: ["a", "b"] },
        terminalDevice: "b",
      },
      { ...flow("legacy", "abf"), world: undefined },
      { ...flow("legacy-fork", "abg"), world: undefined },
    ],
    (item) => item.frames,
    (item) => item.world,
  );
  expect(tree.map(({ flow, fork }) => [flow.name, fork])).toEqual([
    ["online", undefined],
    ["same-world", { parent: 0, at: 2 }],
    ["offline", undefined],
    ["legacy", undefined],
    ["legacy-fork", { parent: 3, at: 2 }],
  ]);
});
