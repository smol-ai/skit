import { Effect } from "effect";
import * as Library from "@smolai/skit-core/library";
import { libraryDoctorReport, inspectNativeDiscovery } from "@smolai/skit-core/library/inventory";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import { Renderer } from "../../terminal/renderer.js";
import { encodeResult } from "../../commands/encode-result.js";
import { presentDoctorCleanup } from "./cleanup.js";
import { doctorOutputContracts } from "./output.js";

/** Own the diagnostic/cleanup/recheck lifecycle; callers choose whether questions are allowed. */
export const runDoctor = Effect.fn("Doctor.run")(function* (input: {
  readonly options: InventoryRootOptions & { readonly cwd: string };
  readonly days: number;
  readonly dryRun: boolean;
  readonly interactive: boolean;
}) {
  const library = yield* Library.Service;
  const renderer = yield* Renderer;
  const diagnose = Effect.gen(function* () {
    const inventory = yield* renderer.withStatus(
      "Scanning harness installations",
      library.inventory.refresh,
    );
    const native = yield* renderer.withStatus(
      "Checking native harness skill discovery",
      inspectNativeDiscovery(inventory, input.options),
    );
    const report = { ...libraryDoctorReport(inventory), ...native };
    yield* renderer.result(encodeResult("doctor", doctorOutputContracts.doctor, report));
    return report;
  });
  const report = yield* diagnose;
  if (input.interactive) {
    const changed = yield* presentDoctorCleanup(
      report.listing_budgets,
      input.options,
      input.days,
      input.dryRun,
    ).pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(false)));
    if (changed) yield* diagnose;
  }
});
