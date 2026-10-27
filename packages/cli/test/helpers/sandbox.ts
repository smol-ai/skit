import { Effect, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { pathIsWithin } from "@smolai/skit-core";

/**
 * The FileSystem a macOS agent sandbox leaves SKIT: every directory creation under `denied` fails
 * with EPERM, which Effect reports as `Unknown` with the errno in its cause. Codex's default
 * sandbox treats `.agents` this way even inside its writable workspace.
 */
export const withSandboxDenying = (denied: string) =>
  Effect.provideServiceEffect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (files) => {
      const refuse = (method: string, path: string) =>
        Effect.fail(
          systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method,
            pathOrDescriptor: path,
            cause: Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
          }),
        );
      return {
        ...files,
        makeDirectory: (path: string, options?: Parameters<typeof files.makeDirectory>[1]) =>
          pathIsWithin(denied, path)
            ? refuse("makeDirectory", path)
            : files.makeDirectory(path, options),
        makeTempDirectory: (options?: Parameters<typeof files.makeTempDirectory>[0]) =>
          options?.directory !== undefined && pathIsWithin(denied, options.directory)
            ? refuse("makeTempDirectory", options.directory)
            : files.makeTempDirectory(options),
      };
    }),
  );
