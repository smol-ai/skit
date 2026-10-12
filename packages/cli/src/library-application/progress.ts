import { Context, Effect, Exit, Layer } from "effect";

export interface LibraryProgressSubject {
  readonly id: string;
  readonly label: string;
}

export type LibraryProgressStage =
  | { readonly kind: "source"; readonly subject: LibraryProgressSubject }
  | { readonly kind: "projection"; readonly subject: LibraryProgressSubject };

export type LibraryProgressCompletion =
  | { readonly kind: "source-inspected"; readonly changed: boolean }
  | { readonly kind: "projections-reconciled"; readonly projected: number };

export type LibraryProgressEvent =
  | { readonly kind: "started"; readonly stage: LibraryProgressStage }
  | {
      readonly kind: "completed";
      readonly stage: LibraryProgressStage;
      readonly result: LibraryProgressCompletion;
    }
  | { readonly kind: "failed"; readonly stage: LibraryProgressStage };

/** Front ends own display and event delivery; workflows describe domain progress only. */
export class LibraryProgress extends Context.Service<
  LibraryProgress,
  {
    readonly around: <A, E, R>(
      stage: LibraryProgressStage,
      operation: Effect.Effect<A, E, R>,
      completed: (value: A) => LibraryProgressCompletion,
    ) => Effect.Effect<A, E, R>;
  }
>()("skit/library/Progress") {}

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

export const silentLibraryProgressLayer = libraryProgressLayer(() => Effect.void);
