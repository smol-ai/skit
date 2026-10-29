import { Console, Effect, FileSystem, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  baseline,
  Configuration,
  pins,
  quote,
  requireTrial,
  sha256,
  VmError,
} from "./configuration.ts";
import { Processes } from "./processes.ts";
import { Tart } from "./tart.ts";
import { withLock, writeAtomic } from "./state.ts";

const Baseline = Schema.Struct({
  fingerprint: Schema.String,
  installed: Schema.String,
  requestedCodex: Schema.optional(Schema.String),
});
const decodeBaseline = Schema.decodeUnknownEffect(Schema.fromJsonString(Baseline));
const decodeAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
export const makeVm = Effect.gen(function* () {
  const config = yield* Configuration;
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* Processes;
  const tart = yield* Tart;
  const marker = join(config.root, "baseline.json");
  const bundled = join(config.root, "tool/tart.app/Contents/MacOS/tart");
  const ready = Effect.gen(function* () {
    if (!(yield* fs.exists(config.tart)))
      return yield* new VmError({ message: "Tart is missing. Run pnpm vm install-tart." });
    const version = yield* tart.run(["--version"], { output: "capture" });
    if (version.stdout.trim() !== pins.tart)
      return yield* new VmError({
        message: `This tool requires Tart ${pins.tart}. Run pnpm vm install-tart.`,
      });
  });
  const baselineRecord = Effect.fn("Vm.baselineRecord")(function* () {
    if (!(yield* fs.exists(marker)))
      return yield* new VmError({ message: "Baseline is not prepared. Run pnpm vm baseline." });
    const record = yield* fs.readFileString(marker).pipe(
      Effect.flatMap(decodeBaseline),
      Effect.mapError(
        () => new VmError({ message: "Baseline metadata is invalid. Run pnpm vm reset." }),
      ),
    );
    if (record.fingerprint !== config.fingerprint)
      return yield* new VmError({
        message: "Baseline versions or preparation changed. Run pnpm vm reset.",
      });
    if ((yield* tart.state(baseline)) !== "stopped")
      return yield* new VmError({
        message: "Baseline must be stopped before cloning. Run pnpm vm stop skit-base.",
      });
    return record;
  });
  const prepare = Effect.fn("Vm.prepare")(function* () {
    if (yield* fs.exists(marker)) {
      yield* baselineRecord();
      yield* Console.log("Baseline is ready.");
      return;
    }
    if (!(yield* tart.state(baseline))) {
      yield* tart.run(["clone", pins.image, baseline], { timeout: "15 minutes" });
      yield* tart.run(["set", baseline, "--cpu", "2", "--memory", "2048"]);
    }
    yield* tart.start(baseline);
    const script = Buffer.from(config.guestScript).toString("utf8");
    yield* tart.job(
      baseline,
      `set -- ${[pins.node, pins.nodeSha256, pins.pnpm, config.requestedCodex, config.fingerprint].map(quote).join(" ")}\n${script}`,
    );
    const installed = yield* tart.guest(
      baseline,
      "node --version; pnpm --version; codex --version",
      { output: "capture" },
    );
    yield* tart.stop(baseline);
    yield* writeAtomic(
      marker,
      JSON.stringify(
        {
          fingerprint: config.fingerprint,
          requestedCodex: config.requestedCodex,
          installed: installed.stdout,
        },
        null,
        2,
      ),
    );
    yield* Console.log("Baseline ready. Run pnpm vm new.");
  });
  const buildCheckout = Effect.fn("Vm.buildCheckout")(function* (name: string) {
    yield* tart.job(
      name,
      `cd "$HOME/skit"
      git init -q
      pnpm install --frozen-lockfile --ignore-scripts
      pnpm --filter @smolai/skit-core build
      pnpm --filter @smolai/skit build
      (cd packages/cli && npm link)
      skit --help`,
    );
  });
  const load = Effect.fn("Vm.load")(function* (name: string) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "skit-vm-" });
        const listed = yield* processes.run(
          "git",
          ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
          { cwd: config.repo, output: "capture" },
        );
        const names = [...new Set(listed.stdout.split("\0").filter(Boolean))];
        const files = yield* Effect.filter(names, (file) =>
          fs.stat(join(config.repo, file)).pipe(
            Effect.as(true),
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound"
                ? fs.readLink(join(config.repo, file)).pipe(
                    Effect.as(true),
                    Effect.catchTag("PlatformError", (linkError) =>
                      linkError.reason._tag === "NotFound"
                        ? Effect.succeed(false)
                        : Effect.fail(linkError),
                    ),
                  )
                : Effect.fail(error),
            ),
          ),
        );
        if (files.length === 0)
          return yield* new VmError({ message: "No checkout files to copy." });
        yield* fs.writeFileString(join(directory, "files"), `${files.join("\0")}\0`);
        const archive = join(directory, "checkout.tar.gz");
        yield* processes.run(
          "tar",
          ["--no-xattrs", "--null", "-T", join(directory, "files"), "-czf", archive],
          {
            cwd: config.repo,
            env: { COPYFILE_DISABLE: "1" },
            timeout: "1 minute",
          },
        );
        yield* tart.guest(
          name,
          'test ! -e "$HOME/skit"; test ! -e "$HOME/skit.partial"; mkdir "$HOME/skit.partial"',
        );
        yield* tart.job(
          name,
          'tar xzf - -C "$HOME/skit.partial"; mv "$HOME/skit.partial" "$HOME/skit"',
          { input: yield* fs.readFile(archive) },
          60,
        );
      }),
    );
  });
  const install = Effect.fn("Vm.install")(function* () {
    const version = yield* processes
      .run(bundled, ["--version"], { output: "capture" })
      .pipe(Effect.result);
    if (version._tag === "Success" && version.success.stdout.trim() === pins.tart) return;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: config.root,
          prefix: "download-",
        });
        const archive = join(directory, "tart.tar.gz");
        yield* processes.run(
          "curl",
          [
            "-fL",
            "--retry",
            "2",
            `https://github.com/openai/tart/releases/download/${pins.tart}/tart.tar.gz`,
            "-o",
            archive,
          ],
          { timeout: "5 minutes" },
        );
        if (sha256(yield* fs.readFile(archive)) !== pins.tartSha256)
          return yield* new VmError({ message: "Tart archive checksum mismatch." });
        const extracted = join(directory, "tool");
        yield* fs.makeDirectory(extracted);
        yield* processes.run("tar", ["-xzf", archive, "-C", extracted]);
        const actual = yield* processes.run(
          join(extracted, "tart.app/Contents/MacOS/tart"),
          ["--version"],
          { output: "capture" },
        );
        if (actual.stdout.trim() !== pins.tart)
          return yield* new VmError({ message: "Unexpected Tart version after extraction." });
        yield* fs.remove(join(config.root, "tool"), { recursive: true, force: true });
        yield* fs.rename(extracted, join(config.root, "tool"));
      }),
    );
  });
  const readAuth = fs.readFile(config.authPath).pipe(
    Effect.mapError(
      () =>
        new VmError({
          message: "Cannot read the host Codex auth cache. Use pnpm vm login <name>.",
        }),
    ),
    Effect.flatMap((bytes) =>
      decodeAuth(Buffer.from(bytes).toString("utf8")).pipe(
        Effect.filterOrFail(
          (value) =>
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.keys(value).length > 0,
          () => new VmError({ message: "Host Codex auth cache is invalid." }),
        ),
        Effect.as(bytes),
        Effect.mapError(
          () =>
            new VmError({
              message:
                "Host Codex auth cache is not a nonempty JSON object. Sign in again on the host.",
            }),
        ),
      ),
    ),
  );
  const copyAuth = Effect.fn("Vm.copyAuth")(function* (name: string) {
    yield* requireTrial(name);
    const bytes = yield* readAuth;
    yield* withLock(
      name,
      Effect.gen(function* () {
        yield* tart.start(name);
        yield* tart.job(
          name,
          `umask 077
        mkdir -p "$HOME/.codex"; chmod 700 "$HOME/.codex"
        pending=$(mktemp "$HOME/.codex/auth.XXXXXX")
        trap 'rm -f "$pending"' EXIT
        cat > "$pending"; test -s "$pending"; chmod 600 "$pending"
        mv -f "$pending" "$HOME/.codex/auth.json"`,
          { input: bytes, secret: true },
          30,
        );
        yield* tart.guest(name, "codex login status", { secret: true });
      }),
    );
    yield* Console.log(`Copied auth privately into ${name}; Codex reports authenticated.`);
  });
  const newTrial = Effect.fn("Vm.newTrial")(function* (
    name = `skit-${randomUUID().slice(0, 8)}`,
    fixture?: "swyx",
  ) {
    yield* requireTrial(name);
    let created = false;
    let checkoutPublished = false;
    yield* withLock(
      name,
      Effect.gen(function* () {
        yield* withLock(
          baseline,
          Effect.gen(function* () {
            yield* baselineRecord();
            if (yield* tart.state(name))
              return yield* new VmError({ message: `${name} already exists.` });
            yield* tart.run(["clone", baseline, name]);
            created = true;
          }),
        );
        yield* tart.start(name);
        yield* tart.guest(
          name,
          `test "$(cat "$HOME/.skit-baseline")" = ${quote(config.fingerprint)}; test ! -e "$HOME/.skit"; test ! -e "$HOME/.codex/auth.json"`,
        );
        yield* load(name);
        checkoutPublished = true;
        yield* buildCheckout(name);
        if (fixture === "swyx") {
          const script = yield* fs.readFileString(
            join(config.repo, "packages/devtools/src/fixtures/swyx.sh"),
          );
          yield* tart.job(name, script, {}, 180);
        }
      }),
    ).pipe(
      Effect.onInterrupt(() =>
        created
          ? Console.error(
              `Trial ${name} was preserved and may still be running. Inspect it with pnpm vm shell ${name}, or stop it with pnpm vm stop ${name}.`,
            )
          : Effect.void,
      ),
      Effect.tapError(() =>
        created
          ? Console.error(
              checkoutPublished && fixture
                ? `Trial ${name} was preserved after a build or fixture failure. Inspect with pnpm vm shell ${name}, or discard with pnpm vm rm ${name} and recreate with --fixture ${fixture}.`
                : checkoutPublished
                  ? `Trial ${name} was preserved. Retry with pnpm vm build ${name}, or discard with pnpm vm rm ${name}.`
                  : `Trial ${name} was preserved with an incomplete transfer. Discard it with pnpm vm rm ${name} and create another trial.`,
            )
          : Effect.void,
      ),
    );
    yield* Console.log(`Ready: ${name}\n  pnpm vm auth-copy ${name}\n  pnpm vm codex ${name}`);
  });
  const attach = Effect.fn("Vm.attach")(function* (
    name: string,
    kind: "shell" | "login" | "codex",
  ) {
    yield* requireTrial(name);
    yield* withLock(name, tart.start(name));
    // The interactive process outlives startup's lock; another shell/new/stop can proceed.
    const workingDirectory = `
      const fs = require("node:fs"), path = require("node:path");
      const home = process.env.HOME;
      const marker = path.join(home, ".skit-vm-fixture.json");
      let cwd = ${JSON.stringify(kind === "codex" ? "skit" : ".")};
      if (fs.existsSync(marker)) {
        cwd = JSON.parse(fs.readFileSync(marker, "utf8")).cwd;
        if (typeof cwd !== "string" || path.isAbsolute(cwd))
          throw new Error("Fixture marker needs a home-relative cwd");
      }
      const target = path.resolve(home, cwd);
      if ((target !== home && !target.startsWith(home + path.sep)) || !fs.statSync(target).isDirectory())
        throw new Error("Session directory must be a directory inside the guest home");
      process.stdout.write(target);
    `;
    const command = [
      "/bin/bash",
      "-lc",
      `export PATH="$HOME/.local/bin:$PATH"
      cwd=$(node -e ${quote(workingDirectory)}) || exit 1
      cd "$cwd" || exit 1
      ${kind === "shell" ? "exec /bin/bash -il" : kind === "login" ? "exec codex login --device-auth" : "exec codex"}`,
    ];
    return (yield* tart.run(["exec", "-i", "-t", name, ...command], {
      interactive: true,
      allowNonzero: true,
    })).code;
  });
  const stopVm = Effect.fn("Vm.stop")(function* (name: string) {
    if (name !== baseline) yield* requireTrial(name);
    yield* withLock(name, tart.stop(name));
  });
  const remove = Effect.fn("Vm.remove")(function* (name: string, allowBaseline: boolean) {
    if (name === baseline && !allowBaseline)
      return yield* new VmError({ message: "Baseline deletion requires --baseline." });
    if (name !== baseline) yield* requireTrial(name);
    yield* withLock(
      name,
      Effect.gen(function* () {
        yield* tart.stop(name);
        yield* tart.run(["delete", name]);
        if (name === baseline) yield* fs.remove(marker, { force: true });
      }),
    );
  });
  const reset = withLock(
    baseline,
    Effect.gen(function* () {
      if (yield* tart.state(baseline)) {
        yield* tart.stop(baseline);
        yield* tart.run(["delete", baseline]);
      }
      yield* fs.remove(marker, { force: true });
      yield* prepare();
    }),
  );
  const build = Effect.fn("Vm.build")(function* (name: string) {
    yield* requireTrial(name);
    yield* withLock(
      name,
      Effect.gen(function* () {
        yield* tart.start(name);
        yield* buildCheckout(name);
      }),
    );
  });
  return {
    ready,
    baseline: withLock(baseline, prepare()),
    install: withLock("tool", install()),
    reset,
    newTrial,
    build,
    copyAuth,
    attach,
    stop: stopVm,
    remove,
    list: tart.run(["list", "--source", "local"]),
  };
});
