import { Context, Effect, Exit, Layer } from "effect";

import type {
  LibraryProgressStage,
  LibraryProgressCompletion,
  LibraryProgressReporter,
} from "@smolai/skit-core/library/update";
export type {
  LibraryProgressStage,
  LibraryProgressCompletion,
  LibraryProgressReporter,
} from "@smolai/skit-core/library/update";

export type LibraryProgressEvent =
  | { readonly kind: "started"; readonly stage: LibraryProgressStage }
  | {
      readonly kind: "completed";
      readonly stage: LibraryProgressStage;
      readonly result: LibraryProgressCompletion;
    }
  | { readonly kind: "failed"; readonly stage: LibraryProgressStage };

/**
 * Front ends own display and event delivery; workflows describe domain progress only.
 * Silent unless a front end provides a reporter.
 */
export const LibraryProgress = Context.Reference<LibraryProgressReporter>("skit/library/Progress", {
  defaultValue: () => ({ around: (_stage, operation) => operation }),
});

/** An explicit event adapter, including failure/interruption after the stage has closed. */
export const libraryProgressLayer = (emit: (event: LibraryProgressEvent) => Effect.Effect<void>) =>
  Layer.succeed(LibraryProgress)({
    around: (stage, operation, completed) =>
      emit({ kind: "started", stage }).pipe(
        Effect.andThen(
          operation.pipe(
            Effect.onExit((exit) =>
              emit(
                Exit.isSuccess(exit)
                  ? { kind: "completed", stage, result: completed(exit.value) }
                  : { kind: "failed", stage },
              ),
            ),
          ),
        ),
      ),
  });
