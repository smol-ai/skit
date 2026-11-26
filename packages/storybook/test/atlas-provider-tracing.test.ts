import { expect, it } from "vitest";
import { Schema } from "effect";
import { ProviderComposition, traceProviders } from "../src/atlas/provider-tracing.ts";

const source = { file: "packages/core/service.ts", line: 1 };
const service = {
  ...source,
  key: "S",
  name: "Service",
  declarations: [source.file],
  incomplete: false,
};
const platform = { ...service, key: "P", name: "Platform" };
const layer = (id: string, provides = [service], requires: typeof provides = []) => ({
  ...source,
  id,
  name: id,
  provides,
  requires,
  actualProvides: provides.map((member) => member.key),
  layer: true,
  local: false,
});
const scope = (id: string, roots = [id]) => ({ ...source, id, name: id, roots });
const composition = Schema.decodeSync(ProviderComposition)({
  layers: [layer("Live", [service], [platform]), layer("Node", [platform]), layer("Fixture")],
  edges: [],
  scopes: [scope("command", ["Live"]), scope("runtime", ["Node"])],
  application: ["runtime"],
});

it("follows only reachable providers and resolves their transitive requirements", () => {
  const result = traceProviders(composition)([service], ["command"]);
  expect(result.requirements[0]?.providers.map((provider) => provider.name)).toEqual(["Live"]);
  const dependency = result.requirements[0]?.providers[0]?.dependencies[0];
  expect(result.traces.find((trace) => trace.id === dependency)?.providers[0]?.name).toBe("Node");
  expect(
    result.traces
      .flatMap((trace) => trace.providers)
      .some((provider) => provider.name === "Fixture"),
  ).toBe(false);
});

it("respects nearer command overrides instead of offering outer or fixture providers", () => {
  const result = traceProviders({
    ...composition,
    scopes: [...composition.scopes, scope("outer", ["Fixture"])],
  })([service], ["command", "outer"]);
  expect(result.requirements[0]?.providers.map((provider) => provider.name)).toEqual(["Live"]);
});

it("shows both merged candidates instead of selecting one", () => {
  const result = traceProviders({
    ...composition,
    layers: [...composition.layers, { ...layer("merged"), combinator: "mergeAll" }],
    edges: [
      { from: "merged", to: "Live", relationship: "call", index: 0 },
      { from: "merged", to: "Fixture", relationship: "call", index: 1 },
    ],
    scopes: [...composition.scopes, scope("ambiguous", ["merged"])],
  })([service], ["ambiguous"]);
  expect(result.requirements[0]?.providers).toEqual([]);
  expect(result.requirements[0]?.candidates.map((provider) => provider.name)).toEqual([
    "Live",
    "Fixture",
  ]);
  expect(result.requirements[0]?.stops[0]?.reason).toMatch(/Ambiguous/);
});

it("keeps a possible non-providing callback return as uncertainty", () => {
  const result = traceProviders({
    ...composition,
    scopes: [...composition.scopes, scope("choice", ["Live", "Node"])],
  })([service], ["choice"]);
  expect(result.requirements[0]?.providers).toEqual([]);
  expect(result.requirements[0]?.candidates.map((provider) => provider.name)).toEqual(["Live"]);
  expect(result.requirements[0]?.stops).toHaveLength(1);
});

it("does not pass an unresolved callback or incomplete output to an outer provider", () => {
  for (const uncertain of [scope("unknown", []), scope("unknown", ["generic"])]) {
    const result = traceProviders({
      ...composition,
      layers: [...composition.layers, layer("generic", [{ ...service, incomplete: true }])],
      scopes: [...composition.scopes, uncertain],
    })([service], ["unknown", "command"]);
    expect(result.requirements[0]?.providers).toEqual([]);
    expect(result.requirements[0]?.stops).toHaveLength(1);
  }
});

it("consumes provide inputs without treating them as output providers", () => {
  const result = traceProviders({
    ...composition,
    layers: [...composition.layers, { ...layer("provided"), combinator: "provide" }],
    edges: [
      { from: "provided", to: "Live", relationship: "call", index: 0 },
      { from: "provided", to: "Node", relationship: "call", index: 1 },
    ],
    scopes: [scope("provided")],
    application: [],
  })([service, platform], ["provided"]);
  const dependency = result.requirements[0]?.providers[0]?.dependencies[0];
  expect(result.traces.find((trace) => trace.id === dependency)?.providers[0]?.name).toBe("Node");
  expect(result.requirements[1]?.providers).toEqual([]);
});

it("never supplies a merged branch from its sibling's outputs", () => {
  const result = traceProviders({
    ...composition,
    layers: [...composition.layers, { ...layer("merged"), combinator: "mergeAll" }],
    edges: [
      { from: "merged", to: "Live", relationship: "call", index: 0 },
      { from: "merged", to: "Node", relationship: "call", index: 1 },
    ],
    scopes: [scope("merged")],
    application: [],
  })([service], ["merged"]);
  const dependency = result.requirements[0]?.providers[0]?.dependencies[0];
  expect(result.traces.find((trace) => trace.id === dependency)?.providers).toEqual([]);
});

it("provides the base from provideMerge without feeding the base's output back into its provider", () => {
  const result = traceProviders({
    ...composition,
    layers: [
      ...composition.layers,
      layer("needsService", [platform], [service]),
      { ...layer("combined", [service, platform]), combinator: "provideMerge" },
    ],
    edges: [
      { from: "combined", to: "Live", relationship: "call", index: 0 },
      { from: "combined", to: "needsService", relationship: "call", index: 1 },
    ],
    scopes: [scope("combined")],
    application: [],
  })([service], ["combined"]);
  const dependency = result.requirements[0]?.providers[0]?.dependencies[0];
  const platformTrace = result.traces.find((trace) => trace.id === dependency);
  expect(platformTrace?.providers[0]?.name).toBe("needsService");
  const reverse = platformTrace?.providers[0]?.dependencies[0];
  expect(result.traces.find((trace) => trace.id === reverse)?.providers).toEqual([]);
});

it("resolves a service needed to construct its override in the outer scope", () => {
  const result = traceProviders({
    ...composition,
    layers: [...composition.layers, layer("override", [service], [service])],
    scopes: [...composition.scopes, scope("override")],
  })([service], ["override", "command"]);
  const dependency = result.requirements[0]?.providers[0]?.dependencies[0];
  expect(result.traces.find((trace) => trace.id === dependency)?.providers[0]?.name).toBe("Live");
});

it("keeps the outer Effect's requirements when unwrap returns a captured configuration", () => {
  const result = traceProviders({
    ...composition,
    layers: [
      ...composition.layers,
      { ...layer("unwrap"), combinator: "unwrap", outerRequires: [platform] },
      layer("captured"),
    ],
    edges: [{ from: "unwrap", to: "captured", relationship: "returned" }],
    scopes: [...composition.scopes, scope("unwrap")],
  })([service], ["unwrap"]);
  const provider = result.requirements[0]?.providers[0];
  expect(provider?.requires.map((member) => member.name)).toEqual(["Platform"]);
  expect(
    result.traces.find((trace) => trace.id === provider?.dependencies[0])?.providers[0]?.name,
  ).toBe("Node");
});

it("stops at captured or unbound Layer parameters", () => {
  const result = traceProviders({
    ...composition,
    layers: [
      ...composition.layers,
      { ...layer("parameter"), definition: { ...source, name: "input", parameter: true } },
    ],
    scopes: [...composition.scopes, scope("parameter")],
  })([service], ["parameter", "command"]);
  expect(result.requirements[0]?.providers).toEqual([]);
  expect(result.requirements[0]?.stops[0]?.reason).toMatch(/parameter/);
});

it("retains distinct factory invocations even when their return declaration is shared", () => {
  const result = traceProviders({
    ...composition,
    layers: [
      ...composition.layers,
      { ...layer("merged"), combinator: "mergeAll" },
      layer("one"),
      layer("two"),
    ],
    edges: [
      { from: "merged", to: "one", relationship: "call" },
      { from: "merged", to: "two", relationship: "call" },
      { from: "one", to: "Live", relationship: "factory" },
      { from: "two", to: "Live", relationship: "factory" },
    ],
    scopes: [...composition.scopes, scope("merged")],
  })([service], ["merged"]);
  expect(result.requirements[0]?.providers).toEqual([]);
  expect(result.requirements[0]?.candidates).toHaveLength(2);
});
