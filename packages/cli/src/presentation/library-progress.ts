import { Effect, Layer } from "effect";
import {
  LibraryProgress,
  type LibraryProgressCompletion,
  type LibraryProgressStage,
} from "../library-application/progress.js";
import { Renderer } from "./renderer.js";

const pendingMessage = (stage: LibraryProgressStage) =>
  `${stage.subject.label} · ${stage.kind === "source" ? "Fetching and inspecting Source" : "Updating installed skills"}`;

const completedMessage = (stage: LibraryProgressStage, result: LibraryProgressCompletion) => {
  const message =
    result.kind === "source-inspected"
      ? result.changed
        ? "New snapshot retained"
        : "Source is current"
      : result.installed
        ? `${result.installed} installed skill${result.installed === 1 ? "" : "s"} updated`
        : "No installed skills needed updating";
  return `${stage.subject.label} · ${message}`;
};

/** Preserve the terminal's scoped spinner and completion lines at the presentation edge. */
export const terminalLibraryProgressLayer = Layer.effect(
  LibraryProgress,
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    return LibraryProgress.of({
      around: (stage, operation, completed) =>
        renderer.withStatus(
          {
            pending: pendingMessage(stage),
            persist: "timed",
            complete: (value) => completedMessage(stage, completed(value)),
          },
          operation,
        ),
    });
  }),
);
