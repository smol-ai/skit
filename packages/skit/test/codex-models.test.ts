import { Option, Schema } from "effect";
import { expect, test } from "vitest";
import {
  ModelContextCatalog,
  modelContextCatalog,
  modelContextWindow,
} from "../src/models/model-context-windows.js";

test("bundled catalog resolves known models without native configuration or cache", () => {
  expect(Option.getOrNull(modelContextWindow("openai", "gpt-6.1-sol"))).toBe(373_000);
  expect(Option.getOrNull(modelContextWindow("openai", "gpt-6-astra"))).toBe(272_000);
  expect(Option.getOrNull(modelContextWindow("openai", "unknown-model"))).toBeNull();
  expect(Option.getOrNull(modelContextWindow("openai", null))).toBeNull();
});

test("catalog rejects duplicate IDs and invalid context windows", () => {
  const decode = Schema.decodeUnknownSync(ModelContextCatalog);
  for (const contextWindow of [0, -1, 1.5, "373000"]) {
    expect(() =>
      decode({
        ...modelContextCatalog,
        models: [{ provider: "openai", id: "model", aliases: [], contextWindow }],
      }),
    ).toThrow();
  }
  expect(() =>
    decode({
      ...modelContextCatalog,
      models: [modelContextCatalog.models[0], modelContextCatalog.models[0]],
    }),
  ).toThrow();
});

test("bundled Anthropic catalog resolves exact models and preserves source provenance", () => {
  expect(Option.getOrNull(modelContextWindow("anthropic", "claude-haiku-4-5"))).toBe(200_000);
  expect(Option.getOrNull(modelContextWindow("anthropic", "claude-opus-4-5-20251101"))).toBe(
    200_000,
  );
  expect(Option.getOrNull(modelContextWindow("anthropic", "claude-sonnet-5-5"))).toBe(1_000_000);
  expect(Option.getOrNull(modelContextWindow("anthropic", "claude-opus-5-5"))).toBe(1_000_000);
  expect(Option.getOrNull(modelContextWindow("anthropic", "opus"))).toBe(1_000_000);
  expect(Option.getOrNull(modelContextWindow("openai", "claude-opus-5-5"))).toBeNull();
  expect(modelContextCatalog.sources.anthropic.url).toBe("https://models.dev/api.json");
});
