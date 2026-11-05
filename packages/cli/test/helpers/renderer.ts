import { terminalLibraryProgressLayer } from "../../src/library/presentation/progress.js";
import { Effect, Layer } from "effect";
import { Renderer, type RendererShape } from "../../src/terminal/renderer.js";

const silent: RendererShape = {
  result: () => Effect.void,
  failure: () => Effect.void,
  help: () => Effect.void,
  note: () => Effect.void,
  instruction: () => Effect.void,
  step: () => Effect.void,
  updateStatus: () => Effect.void,
  withStatus: (_message, operation) => operation,
};

export const rendererTestLayer = (overrides: Partial<RendererShape> = {}) =>
  terminalLibraryProgressLayer.pipe(
    Layer.provideMerge(Layer.succeed(Renderer, Renderer.of({ ...silent, ...overrides }))),
  );
