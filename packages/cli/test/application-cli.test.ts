import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("real inventory interrupts state output and finalizes its temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "skit-inventory-signal-"));
  const home = join(root, "home");
  await mkdir(home);
  const preload = join(root, "inventory-gate.mjs");
  // Gate the callback of a real state-file write. The native runtime must still run its
  // scoped unlink finalizer when the command receives SIGINT.
  await writeFile(
    preload,
    `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const writeFile = fs.writeFile;
fs.writeFile = function(path, ...args) {
  const callback = args.pop();
  return writeFile.call(this, path, ...args, (error) => {
    if (String(path).includes("state.json.tmp-")) { process.send?.("state-written"); return; }
    callback(error);
  });
};
syncBuiltinESMExports();
`,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      preload,
      join(process.cwd(), "bin/skit.js"),
      "inventory",
      "--json",
      "--home",
      home,
      "--codex-root",
      join(root, "codex"),
      "--claude-root",
      join(root, "claude"),
      "--opencode-root",
      join(root, "opencode"),
    ],
    {
      env: { ...process.env, SKIT_HOME: home },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve) => {
    child.on("message", (message) => {
      if (message === "state-written") resolve();
    });
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  try {
    await Promise.race([
      ready,
      exited.then((exit) => {
        throw new Error(`Exited before gate: ${JSON.stringify(exit)} ${stderr}`);
      }),
    ]);
    expect((await readdir(home)).filter((name) => name.includes(".tmp-"))).toHaveLength(1);
    child.kill("SIGINT");
    expect(await exited).toEqual({ code: 130, signal: null });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(await readdir(home)).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
