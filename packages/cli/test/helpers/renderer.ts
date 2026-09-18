import { Effect, Layer } from "effect";
import { Renderer, type RendererShape } from "../../src/presentation/renderer.js";

const silent: RendererShape = {
  result: () => Effect.void,
  failure: () => Effect.void,
  help: () => Effect.void,
  note: () => Effect.void,
  updateStatus: () => Effect.void,
  withStatus: (_message, operation) => operation,
};

export const rendererTestLayer = (overrides: Partial<RendererShape> = {}) =>
  Layer.succeed(Renderer, Renderer.of({ ...silent, ...overrides }));
