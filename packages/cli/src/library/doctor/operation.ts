import { libraryDoctorReport, inspectNativeDiscovery } from "@smolai/skit-core/library/inventory";
import { Effect } from "effect";
import { Renderer } from "../../terminal/renderer.js";
import { refreshLibraryInventory, type CliInventoryOptions } from "../inventory.js";

/** Diagnose the same freshly persisted observation; report construction is pure. */
export const doctorCommand = Effect.fn("CLI.doctor")(function* (options: CliInventoryOptions) {
  const inventory = yield* refreshLibraryInventory(options);
  const report = libraryDoctorReport(inventory);
  const renderer = yield* Renderer;
  const native = yield* renderer.withStatus(
    "Checking native harness skill discovery",
    inspectNativeDiscovery(inventory, { ...options, cwd: process.cwd() }),
  );
  return { ...report, ...native };
});
