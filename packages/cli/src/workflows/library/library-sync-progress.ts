import { Effect } from "effect";

export type SyncPhase =
  | {
      readonly kind:
        | "inspect-local"
        | "read-remote"
        | "merge"
        | "check-destinations"
        | "check-projections"
        | "check-enabled"
        | "save-remote"
        | "save-local"
        | "enable";
    }
  | { readonly kind: "verify-copies" | "upload"; readonly total: number };

export interface SyncProgress {
  readonly around: <A, E, R>(
    phase: SyncPhase,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly tick: (tick: {
    readonly phase: SyncPhase;
    /** Number of items whose work has completed successfully. */
    readonly completed: number;
  }) => Effect.Effect<void>;
}

export const silentSyncProgress: SyncProgress = {
  around: (_phase, operation) => operation,
  tick: () => Effect.void,
};
