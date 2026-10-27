import type { Effect } from "effect";

export type RestorePhase =
  | { readonly kind: "verify-local"; readonly total: number }
  | { readonly kind: "download"; readonly total: number }
  | { readonly kind: "fetch-source"; readonly subject: string }
  | { readonly kind: "retain"; readonly total: number };

export interface RestoreTick {
  readonly phase: RestorePhase;
  /** Number of items whose work has completed successfully. */
  readonly completed: number;
  readonly subject?: string;
}

/** Restore facts only. Front ends own wording, elapsed time, and delivery. */
export interface RestoreProgress {
  readonly around: <A, E, R>(
    phase: RestorePhase,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly tick: (tick: RestoreTick) => Effect.Effect<void>;
}
