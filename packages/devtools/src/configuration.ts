import { Config, Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class VmError extends Schema.TaggedError<VmError>()("VmError", { message: Schema.String }) {}
export const pins = {
  tart: "2.41.1",
  tartSha256: "e680a734febccfce7d4e910c1f7f13fc3b00f19a181c945e2d746de3214c32c2",
  image:
    "ghcr.io/cirruslabs/debian@sha256:26d5e519b5f25ed7e165cc2e138695a3541b0b7e53f267bb63bb08a49588bdfa",
  node: "22.23.4",
  nodeSha256: "6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b",
  pnpm: "11.23.0",
};
export const baseline = "skit-base";
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export interface VmConfiguration {
  readonly repo: string;
  readonly root: string;
  readonly tart: string;
  readonly authPath: string;
  readonly requestedCodex: string;
  readonly guestScript: Uint8Array;
  readonly fingerprint: string;
}
export class Configuration extends Context.Service<Configuration, VmConfiguration>()(
  "devtools/Configuration",
) {}
export const configurationLayer = Layer.effect(
  Configuration,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const root = resolve(
      yield* Config.String("SKIT_VM_HOME").pipe(
        Config.withDefault(join(homedir(), "Library/Application Support/skit-dev/tart")),
      ),
    );
    const guestScript = yield* fs.readFile(join(repo, "packages/devtools/src/prepare-guest.sh"));
    return Configuration.of({
      repo,
      root,
      guestScript,
      tart: yield* Config.String("TART_BIN").pipe(
        Config.withDefault(join(root, "tool/tart.app/Contents/MacOS/tart")),
      ),
      authPath: join(
        yield* Config.String("CODEX_HOME").pipe(Config.withDefault(join(homedir(), ".codex"))),
        "auth.json",
      ),
      requestedCodex: Option.getOrElse(
        yield* Config.option(Config.String("CODEX_VERSION")),
        () => "latest",
      ),
      // Requested Codex affects preparation only. Clone compatibility follows the recorded baseline.
      fingerprint: sha256(Buffer.concat([Buffer.from(JSON.stringify(pins)), guestScript])),
    });
  }),
);
export const requireTrial = (name: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name.slice(5)) && name.startsWith("skit-") && name !== baseline
    ? Effect.void
    : Effect.fail(
        new VmError({
          message: "Supply a trial name starting with skit- (not skit-base). Use pnpm vm list.",
        }),
      );
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
