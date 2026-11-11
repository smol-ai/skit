import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { isPlatformError, systemError } from "effect/PlatformError";
import { join } from "node:path";
import { SyncIssue } from "@smolai/skit-core/library/sync";
import { devices } from "./helpers/library-sync-devices.js";
import { testPlatformLayer } from "./helpers/platform.js";

it.effect(
  "sync reports native scan and installation failures as facts, then retries without losing the device choice",
  () =>
    Effect.gen(function* () {
      const native = yield* FileSystem.FileSystem;
      let unreadableRoot: string | undefined;
      let unreadableAlias: string | undefined;
      let refuseStaging = false;
      const readFailure = systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readDirectory",
        pathOrDescriptor: "/skills/unreadable",
      });
      const installFailure = systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeTempDirectoryScoped",
        pathOrDescriptor: "/skills/staging",
      });
      const files = FileSystem.FileSystem.of({
        ...native,
        readDirectory: (path) =>
          path === unreadableRoot ? Effect.fail(readFailure) : native.readDirectory(path),
        realPath: (path) =>
          path === unreadableAlias ? Effect.fail(readFailure) : native.realPath(path),
        makeTempDirectoryScoped: (options) =>
          refuseStaging && options?.prefix === ".skit-stage-"
            ? Effect.fail(installFailure)
            : native.makeTempDirectoryScoped(options),
      });
      const { a, b, c, remote } = yield* devices.pipe(
        Effect.provideService(FileSystem.FileSystem, files),
      );
      yield* a.importSource("first");
      yield* a.sync();
      const head = yield* remote;
      unreadableRoot = b.root;
      const scanned = yield* b.sync({ deviceSelection: { skills: ["first"], collections: [] } });
      assert.strictEqual(scanned.status, "enablement_incomplete");
      if (scanned.status !== "enablement_incomplete") return;
      const scanIssue = scanned.enablement_issues?.find(
        (issue) => issue._tag === "DuplicateScanFailed",
      );
      assert.strictEqual(scanIssue?._tag, "DuplicateScanFailed");
      if (scanIssue?._tag !== "DuplicateScanFailed") return;
      // Sync has saved and decoded its plan and operation receipt by this point.
      assert.isTrue(isPlatformError(scanIssue.failure));
      if (scanIssue.failure._tag === "PlatformError")
        assert.deepEqual(scanIssue.failure.reason, readFailure.reason);
      unreadableRoot = undefined;
      assert.strictEqual((yield* b.sync()).status, "clean");
      assert.strictEqual(
        yield* native.readFileString(join(b.root, "first", "SKILL.md")),
        "first\n",
      );
      const unrelated = join(b.root, "unrelated");
      yield* native.makeDirectory(unrelated);
      yield* native.writeFileString(join(unrelated, "SKILL.md"), "unrelated copy\n");
      unreadableAlias = unrelated;
      const incompleteScan = yield* b.sync();
      assert.strictEqual(incompleteScan.status, "enablement_incomplete");
      if (incompleteScan.status !== "enablement_incomplete") return;
      const warning = incompleteScan.enablement_issues?.find(
        (issue) => issue._tag === "DuplicateScanFailed",
      );
      assert.strictEqual(warning?._tag, "DuplicateScanFailed");
      if (
        warning?._tag === "DuplicateScanFailed" &&
        warning.failure._tag === "DuplicateScanIncomplete"
      ) {
        assert.strictEqual(warning.failure.path, unrelated);
        assert.strictEqual(warning.failure.reason._tag, "Unreadable");
      } else assert.fail("Expected the incomplete-scan warning to survive as facts");
      unreadableAlias = undefined;
      assert.strictEqual((yield* b.sync()).status, "clean");
      refuseStaging = true;
      const installed = yield* c.sync({ deviceSelection: { skills: ["first"], collections: [] } });
      assert.strictEqual(installed.status, "enablement_incomplete");
      if (installed.status !== "enablement_incomplete") return;
      const installationIssue = installed.enablement_issues?.find(
        (issue) => issue._tag === "InstallationFailed",
      );
      assert.strictEqual(installationIssue?._tag, "InstallationFailed");
      if (installationIssue?._tag !== "InstallationFailed") return;
      assert.isTrue(isPlatformError(installationIssue.failure));
      if (installationIssue.failure._tag === "PlatformError")
        assert.deepEqual(installationIssue.failure.reason, installFailure.reason);
      const wire = yield* Schema.encodeEffect(Schema.toCodecJson(SyncIssue))(installationIssue);
      const stored = yield* Schema.decodeUnknownEffect(SyncIssue)(JSON.parse(JSON.stringify(wire)));
      assert.strictEqual(stored._tag, "InstallationFailed");
      if (stored._tag === "InstallationFailed" && stored.failure._tag === "PlatformError")
        assert.deepEqual(stored.failure.reason, installFailure.reason);
      else assert.fail("Expected stored native installation facts");
      refuseStaging = false;
      assert.strictEqual((yield* c.sync()).status, "clean");
      assert.strictEqual(
        yield* native.readFileString(join(c.root, "first", "SKILL.md")),
        "first\n",
      );
      assert.deepEqual(yield* remote, head);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
