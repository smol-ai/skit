import type { RestoreProgress, RestorePhase } from "@smolai/skit-core";
import type { SyncProgress, SyncPhase } from "../workflows/library/library-sync-progress.js";
import type { RendererShape } from "./renderer.js";

const copies = (count: number, qualifier = "Skill") =>
  `${count} ${qualifier} cop${count === 1 ? "y" : "ies"}`;

const syncStatus = (phase: SyncPhase) => {
  switch (phase.kind) {
    case "inspect-local":
      return {
        pending: "Inspecting this device’s Library",
        complete: "Inspected this device’s Library",
      };
    case "verify-copies":
      return { pending: "Verifying retained copies", complete: "Checked retained copies" };
    case "read-remote":
      return { pending: "Reading remote Library", complete: "Read remote Library" };
    case "merge":
      return { pending: "Planning Library sync", complete: "Compared Library changes" };
    case "check-destinations":
      return { pending: "Checking Skill destinations", complete: "Checked Skill destinations" };
    case "check-installed-skills":
      return { pending: "Checking installed skills", complete: "Checked installed skills" };
    case "check-enabled":
      return { pending: "Checking enabled Skills", complete: "Checked enabled Skills" };
    case "save-remote":
      return { pending: "Saving remote Library", complete: "Saved remote Library" };
    case "save-local":
      return { pending: "Saving this device’s Library", complete: "Saved this device’s Library" };
    case "enable":
      return { pending: "Enabling synced Skills", complete: "Reconciled enabled Skills" };
    case "upload":
      return {
        pending: `Uploading ${copies(phase.total)}`,
        complete: `Uploaded ${copies(phase.total)}`,
      };
  }
};

const restoreStatus = (phase: RestorePhase) => {
  switch (phase.kind) {
    case "verify-local":
      return {
        pending: "Checking local retained copies",
        complete: "Checked for reusable retained copies",
      };
    case "download":
      return {
        pending: `Downloading ${copies(phase.total)}`,
        complete: `Downloaded ${copies(phase.total)}`,
      };
    case "fetch-source":
      return { pending: `Fetching ${phase.subject}`, complete: `Fetched ${phase.subject}` };
    case "retain":
      return {
        pending: `Restoring ${copies(phase.total, "retained")}`,
        complete: `Restored ${copies(phase.total, "retained")}`,
      };
  }
};

/** Domain operations supply facts; this adapter owns terminal wording and persistence. */
export const terminalSyncProgress = (
  renderer: Pick<RendererShape, "withStatus" | "updateStatus">,
): {
  readonly sync: SyncProgress;
  readonly restore: RestoreProgress;
} => ({
  sync: {
    around: (phase, operation) =>
      renderer.withStatus({ ...syncStatus(phase), persist: "timed" }, operation),
    tick: ({ phase, completed }) =>
      renderer.updateStatus(
        `${syncStatus(phase).pending}${"total" in phase ? ` · ${completed}/${phase.total}` : ""}`,
      ),
  },
  restore: {
    around: (phase, operation) =>
      renderer.withStatus({ ...restoreStatus(phase), persist: "timed" }, operation),
    tick: ({ phase, completed, subject }) =>
      renderer.updateStatus(
        `${restoreStatus(phase).pending}${"total" in phase ? ` · ${completed}/${phase.total}` : ""}${subject === undefined ? "" : ` · ${subject}`}`,
      ),
  },
});
