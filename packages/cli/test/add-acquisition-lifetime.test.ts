// Cancelling an acquisition, in a real process.
//
// `add-cli-lifetime.test.ts` covers the mutating add either side of its durable commit, over a
// local directory. Acquisition itself has two other kinds of live work a signal has to reach: a
// response body being read from the network, and a child process doing the fetching. This covers
// both, for `add --list` as well as the mutating add.
//
// Everything is disposable and local: a loopback HTTP server for the Registry download, a `git`
// shim on PATH for the child process. `TMPDIR` is redirected per run, so "the acquisition
// workspace was removed and did not come back" is checked by looking at an otherwise empty
// directory rather than by guessing a path.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { isolatedRoots } from "./helpers/isolated-library.js";

const bin = join(process.cwd(), "bin", "skit.js");
const REPO = "https://example.invalid/fixtures/tools.git";

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

/** Poll a condition rather than a duration, so nothing here depends on how fast a machine is. */
async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

interface Run {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  roots: ReturnType<typeof isolatedRoots>,
): Run {
  const child = spawn(
    process.execPath,
    [
      bin,
      ...args,
      "--json",
      "--home",
      roots.home,
      "--codex-root",
      roots.codexRoot,
      "--claude-root",
      roots.claudeRoot,
      "--opencode-root",
      roots.opencodeRoot,
      "--devin-root",
      roots.devinRoots[0],
    ],
    { env, stdio: "ignore" },
  );
  return {
    child,
    exited: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  };
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );

test.each([
  ["add", "SIGINT"],
  ["add", "SIGTERM"],
  ["preview", "SIGINT"],
  ["preview", "SIGTERM"],
] as const)(
  "%s interrupted mid-download on %s cancels the body and leaves nothing",
  async (mode, signal) => {
    const root = await mkdtemp(join(tmpdir(), "skit-acq-lifetime-"));
    const temporary = join(root, "tmp");
    await mkdir(temporary, { recursive: true });
    const roots = isolatedRoots(root);
    const state = { reading: false, aborted: false };
    const server = createServer((request, response) => {
      response.writeHead(200, {
        "content-type": "application/zip",
        "skit-release-version": "1.0.0",
      });
      // Headers and a first chunk, then the body never ends: there is live work to cancel.
      response.write(Buffer.alloc(64));
      state.reading = true;
      request.on("aborted", () => (state.aborted = true));
      response.on("close", () => (state.aborted = true));
    });
    const port = await listen(server);
    try {
      const run = runCli(
        mode === "preview" ? ["add", "skit:alice/tools", "--list"] : ["add", "skit:alice/tools"],
        {
          ...process.env,
          SKIT_SERVER_URL: `http://127.0.0.1:${port}`,
          SKIT_HOME: roots.home,
          TMPDIR: temporary,
        },
        roots,
      );

      await until(() => state.reading, "the download body to start");
      // The response never ends, so the command cannot finish on its own. Reaching exit 130 at
      // all is therefore the evidence that the signal cancelled the body read rather than the
      // read completing: an uncancelled one would block here forever.
      expect(run.child.exitCode).toBe(null);
      run.child.kill(signal);
      expect(await run.exited).toEqual({ code: 130, signal: null });
      // The server also saw the connection end.
      expect(state.aborted).toBe(true);

      // The acquisition workspace finalized, and no abandoned work recreated it.
      expect(await readdir(temporary)).toEqual([]);
      await settle();
      expect(await readdir(temporary)).toEqual([]);
      // Neither shape publishes anything; preview must not even create the Library.
      expect(existsSync(join(roots.home, "state.json"))).toBe(false);
      expect(existsSync(join(roots.home, "originals"))).toBe(false);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

/** A `git` whose checkout records its pid and then never finishes. */
async function stallingGit(root: string, marker: string) {
  const directory = join(root, "bin");
  await mkdir(directory, { recursive: true });
  const shim = join(directory, "git");
  await writeFile(
    shim,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "clone") {
  fs.mkdirSync(process.argv.at(-1), { recursive: true });
} else if (process.argv[2] === "checkout") {
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  // Hold the acquisition open with a real child process for the signal to reach.
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
`,
  );
  await chmod(shim, 0o755);
  return directory;
}

test.each(["SIGINT", "SIGTERM"] as const)(
  "add interrupted during a child process on %s terminates it and cleans up",
  async (signal) => {
    const root = await mkdtemp(join(tmpdir(), "skit-acq-child-"));
    const temporary = join(root, "tmp");
    await mkdir(temporary, { recursive: true });
    const roots = isolatedRoots(root);
    const marker = join(root, "checkout.pid");
    const shimDirectory = await stallingGit(root, marker);
    try {
      const run = runCli(
        ["add", REPO],
        {
          ...process.env,
          PATH: `${shimDirectory}:${process.env.PATH}`,
          SKIT_HOME: roots.home,
          TMPDIR: temporary,
        },
        roots,
      );

      await until(() => existsSync(marker), "the checkout child to start");
      const pid = Number(await readFile(marker, "utf8"));
      expect(Number.isInteger(pid)).toBe(true);
      // The checkout never returns, so the command cannot finish on its own either.
      expect(run.child.exitCode).toBe(null);
      expect(alive(pid)).toBe(true);
      run.child.kill(signal);
      expect(await run.exited).toEqual({ code: 130, signal: null });

      // The child is gone, not orphaned: acquisition's Scope owns the process, and cleanup waited
      // for it before releasing the workspace it was writing into.
      await until(() => !alive(pid), "the checkout child to terminate");
      expect(alive(pid)).toBe(false);
      expect(await readdir(temporary)).toEqual([]);
      await settle();
      expect(await readdir(temporary)).toEqual([]);
      expect(existsSync(join(roots.home, "state.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
