import {
  SetupOutput,
  SetupComparisonOutput,
  SetupAppliedOutput,
  SetupReviewOutput,
  SetupFailureOutput,
} from "./actions.js";
import { SetupUndoOutput } from "./undo-result.js";

export const setupOutputContracts = {
  setup: { id: "skit.setup.v8", schema: SetupOutput },
  setupApplied: { id: "skit.setup.applied.v4", schema: SetupAppliedOutput },
  setupReview: { id: "skit.setup.review.v3", schema: SetupReviewOutput },
  setupFailed: { id: "skit.setup.failed.v1", schema: SetupFailureOutput },
  setupComparison: { id: "skit.setup.comparison.v2", schema: SetupComparisonOutput },
  setupUndo: { id: "skit.setup.undo.v2", schema: SetupUndoOutput },
} as const;
