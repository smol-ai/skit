import { Effect, FileSystem, Stream } from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { SkitError } from "../shared/skit-error.js";
import type { DescriptorFailure } from "../failures.js";
import { SkitValidationFailed } from "../failures.js";
import { validateSkitDirectoryEffect } from "../artifact/skit.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import type { TreeError } from "../shared/tree-error.js";

export function createSkitArchiveEffect(
  root: string,
  outputPath: string,
): Effect.Effect<
  { path: string; bytes: number },
  DescriptorFailure | SkitValidationFailed | SkitError | TreeError | PlatformError,
  TreeRequirements | FileSystem.FileSystem
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const validation = yield* validateSkitDirectoryEffect(root, "archive", {
        assessmentContext: "publish",
      });
      const errors = validation.diagnostics.filter((item) => item.severity === "error");
      if (errors.length)
        return yield* new SkitValidationFailed({ diagnostics: errors.map((item) => item.code) });
      yield* fs.makeDirectory(dirname(resolve(outputPath)), { recursive: true });
      // addBuffer with compress:false owns no file streams or zlib jobs. yazl can queue
      // buffer pumping before the sink starts; always close its output, including read failures.
      const zip = yield* Effect.acquireRelease(
        Effect.sync(() => new ZipFile()),
        (zip) =>
          Effect.callback<void>((resume) => {
            // yazl types expose only NodeJS.ReadableStream; the implementation is a PassThrough.
            if (!(zip.outputStream instanceof Readable))
              throw new TypeError("Expected yazl Readable output");
            if (zip.outputStream.closed) return resume(Effect.void);
            zip.outputStream.once("close", () => resume(Effect.void));
            zip.outputStream.destroy();
          }),
      );
      // ZIP stores DOS timestamps as local calendar fields. Construct the epoch in local time so
      // every timezone writes the same 1980-01-01 00:00 fields.
      const timestamp = new Date(1980, 0, 1, 0, 0, 0, 0);
      for (const file of validation.files)
        zip.addBuffer(Buffer.from(yield* fs.readFile(join(root, file.path))), file.path, {
          compress: false,
          mtime: timestamp,
          mode: file.executable ? 0o100755 : 0o100644,
          forceDosTimestamp: true,
        });
      // yazl's output is a Node Readable, which is an async iterable, so it feeds the sink directly.
      const written = Stream.run(
        Stream.fromAsyncIterable(zip.outputStream as AsyncIterable<Uint8Array>, (cause) =>
          systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "createSkitArchive",
            pathOrDescriptor: outputPath,
            cause,
          }),
        ),
        fs.sink(outputPath, { flag: "wx", mode: 0o600 }),
      );
      zip.end({ forceZip64Format: false, comment: "" });
      yield* written;
      const info = yield* fs.stat(outputPath);
      return { path: resolve(outputPath), bytes: Number(info.size) };
    }),
  );
}
