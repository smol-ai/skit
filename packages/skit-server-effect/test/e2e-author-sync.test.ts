import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Schema } from "effect";
import { createTestHarness } from "wrangler";
import { expect, test } from "vitest";
import * as History from "@smolai/skit-core/history";
import { RevisionReadResponse, SkitCurrentResponse } from "@smolai/skit-core/universal/authoring";
import { CreatedPat } from "@smolai/skit-core/api";
import type { RuntimeEnv } from "../src/platform/cloudflare.js";

const Captured = Schema.TaggedStruct("Success", {
  value: Schema.Struct({ id: History.RevisionId, treeHash: History.TreeHash }),
});
const execute = promisify(execFile);
const serverRoot = resolve(import.meta.dirname, "..");
const client = resolve(serverRoot, "../cli/dist/test/fixtures/author-sync-client.js");
const secrets = {
  BETTER_AUTH_SECRET: "skit-author-sync-e2e-auth-secret-at-least-thirty-two-characters",
  SKIT_BOOTSTRAP_SECRET: "skit-author-sync-e2e-bootstrap-secret-at-least-thirty-two-characters",
};

test("separate author processes back up offline history and converge through real Registry D1/R2", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skit-author-registry-"));
  const a = { root: join(directory, "a"), home: join(directory, "a-home") };
  const b = { root: join(directory, "b"), home: join(directory, "b-home") };
  const server = createTestHarness({
    root: serverRoot,
    workers: [{ configPath: "./test/wrangler.test.jsonc", secrets }],
  });
  try {
    const { url } = await server.listen();
    expect(["127.0.0.1", "localhost", "::1"]).toContain(url.hostname);
    await server.update({
      root: serverRoot,
      workers: [
        {
          configPath: "./test/wrangler.test.jsonc",
          vars: { PUBLIC_APP_ORIGIN: url.origin, ACCOUNT_REGISTRATION_MODE: "closed" },
          secrets,
        },
      ],
    });
    const worker = server.getWorker<RuntimeEnv>();
    await worker.applyD1Migrations("DB");
    const headers = {
      "content-type": "application/json",
      origin: url.origin,
      "cf-connecting-ip": "192.0.2.140",
    };
    const bootstrap = await fetch(new URL("/api/bootstrap", url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: secrets.SKIT_BOOTSTRAP_SECRET,
        username: "author-proof",
        email: "author-proof@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(201);
    const signedIn = await fetch(new URL("/api/auth/sign-in/email", url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: "author-proof@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const issued = await fetch(new URL("/api/tokens", url), {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({
        name: "Author sync E2E",
        scopes: ["library:sync", "authoring:write"],
      }),
    });
    expect(issued.status, await issued.clone().text()).toBe(201);
    const { token } = Schema.decodeUnknownSync(CreatedPat)(await issued.json());
    const run = async (
      device: typeof a,
      mode: "capture" | "sync",
      first = false,
    ): Promise<unknown> => {
      const result = await execute(
        process.execPath,
        [
          client,
          mode,
          device.root,
          device.home,
          first ? "first" : "connected",
          "author-proof/tools",
        ],
        {
          env: {
            ...process.env,
            SKIT_HOME: device.home,
            SKIT_SERVER_URL: url.origin,
            SKIT_TOKEN: mode === "capture" ? "" : token,
          },
          timeout: 40_000,
        },
      );
      return JSON.parse(result.stdout.trim());
    };
    const request = async (path: string) => {
      const response = await fetch(new URL(`/api/skits/author-proof/tools/${path}`, url), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    const current = async () =>
      Schema.decodeUnknownSync(SkitCurrentResponse)(await request("current")).current;
    const revision = async (id: string) =>
      Schema.decodeUnknownSync(Schema.toCodecJson(RevisionReadResponse))(
        await request(`revisions/${id}`),
      );
    const text = (tree: typeof RevisionReadResponse.Type.tree, path: string) => {
      const entry = tree.find((entry) => entry.path === path);
      return entry?.kind === "file" ? new TextDecoder().decode(entry.bytes) : undefined;
    };
    await mkdir(a.root);
    await writeFile(join(a.root, "notes.txt"), "initial");
    expect(await run(a, "sync", true)).toMatchObject({
      _tag: "Success",
      value: { status: "created", published: false },
    });
    const initial = await current();
    const observations: Array<{ id: string; treeHash: string }> = [];
    for (const bytes of ["A", "B", "A"]) {
      await writeFile(join(a.root, "notes.txt"), bytes);
      const captured = Schema.decodeUnknownSync(Captured)(await run(a, "capture")); // New process, no network credential.
      observations.push(captured.value);
    }
    expect(observations[0].treeHash).toBe(observations[2].treeHash);
    expect(observations[0].id).not.toBe(observations[2].id);
    expect(await current()).toBe(initial);
    expect(await run(a, "sync")).toMatchObject({ _tag: "Success", value: { status: "pushed" } });
    for (const [index, observation] of observations.entries()) {
      const stored = await revision(observation.id);
      expect(text(stored.tree, "notes.txt")).toBe(["A", "B", "A"][index]);
      expect(stored.revision.tree).toBe(observation.treeHash);
      if (index > 0) expect(stored.revision.parents).toEqual([observations[index - 1].id]);
    }
    await mkdir(b.root);
    // Supply only the portable remote home. Workspace identity, machine identity and sync
    // checkpoints are fresh; this tests bootstrap after connection, not a new connection UI.
    await writeFile(
      join(b.root, "skit.remote.json"),
      await readFile(join(a.root, "skit.remote.json")),
    );
    expect(await run(b, "sync")).toMatchObject({ _tag: "Success" });
    expect(await readFile(join(b.root, "notes.txt"), "utf8")).toBe("A");
    await writeFile(join(a.root, "a.txt"), "independent A");
    await writeFile(join(b.root, "b.txt"), "independent B");
    expect(await run(a, "sync")).toMatchObject({ _tag: "Success" });
    expect(await run(b, "sync")).toMatchObject({ _tag: "Success", value: { status: "merged" } });
    expect(await run(a, "sync")).toMatchObject({ _tag: "Success" });
    for (const device of [a, b]) {
      expect(await readFile(join(device.root, "a.txt"), "utf8")).toBe("independent A");
      expect(await readFile(join(device.root, "b.txt"), "utf8")).toBe("independent B");
    }
    const env = await worker.getEnv();
    const revisionCount = async () =>
      (await env.DB.prepare("SELECT COUNT(*) count FROM revisions").first<{ count: number }>())
        ?.count;
    await writeFile(join(a.root, "crash.txt"), "kept after SIGKILL");
    const interruptedObservation = Schema.decodeUnknownSync(Captured)(await run(a, "capture"));
    const beforeInterruptedPost = await current();
    const interrupted = spawn(
      process.execPath,
      [client, "hold-post", a.root, a.home, "connected", "author-proof/tools"],
      {
        env: { ...process.env, SKIT_HOME: a.home, SKIT_SERVER_URL: url.origin, SKIT_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const lines = createInterface({ input: interrupted.stdout });
    try {
      const [line] = await once(lines, "line", { signal: AbortSignal.timeout(30_000) });
      expect(JSON.parse(line)).toEqual({ event: "revision-accepted" });
      // The response is held inside the real HTTP client, before backupState.save. Check the
      // actual server's stored bytes and current pointer before killing the process.
      expect(text((await revision(interruptedObservation.value.id)).tree, "crash.txt")).toBe(
        "kept after SIGKILL",
      );
      expect(await current()).toBe(beforeInterruptedPost);
      const stopped = once(interrupted, "exit");
      expect(interrupted.kill("SIGKILL")).toBe(true);
      expect(await stopped).toEqual([null, "SIGKILL"]);
    } finally {
      lines.close();
      if (interrupted.exitCode === null && interrupted.signalCode === null) {
        const stopped = once(interrupted, "exit");
        interrupted.kill("SIGKILL");
        await stopped;
      }
    }
    const acceptedCount = await revisionCount();
    if (acceptedCount === undefined) throw new Error("Missing persisted revision count");
    expect(await run(a, "sync")).toMatchObject({ _tag: "Success", value: { status: "pushed" } });
    // Replaying the raw observation is idempotent: only the separate canonical revision is new.
    expect(await revisionCount()).toBe(acceptedCount + 1);
    expect(text((await revision(interruptedObservation.value.id)).tree, "crash.txt")).toBe(
      "kept after SIGKILL",
    );
    expect(await run(b, "sync")).toMatchObject({ _tag: "Success" });
    expect(await readFile(join(b.root, "crash.txt"), "utf8")).toBe("kept after SIGKILL");
    // Exercise the shipped foreground command in separate background processes. Assertions
    // read real guest files and the Worker/D1/R2 Registry, rather than accepting log messages
    // as proof of convergence. This same scenario runs in disposable Linux VMs.
    const command = resolve(serverRoot, "../cli/bin/skit.js");
    const watchers = new Set<ReturnType<typeof spawn>>();
    const startWatch = async (device: typeof a) => {
      const child = spawn(
        process.execPath,
        [command, "author", "watch", device.root, "--home", device.home, "--json"],
        {
          env: { ...process.env, SKIT_SERVER_URL: url.origin, SKIT_TOKEN: token },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      watchers.add(child);
      const output: string[] = [];
      const events: Array<{
        event: string;
        revision_id?: string;
        result?: { status: string; revision_id?: string };
      }> = [];
      const stream = createInterface({ input: child.stdout });
      stream.on("line", (line) => {
        output.push(line);
        events.push(JSON.parse(line).data);
      });
      child.stderr.on("data", (chunk) => output.push(String(chunk)));
      await expect
        .poll(
          () => {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(`Watcher exited: ${output.join("\n")}`);
            return events.some((event) => event.event === "watching");
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      return { child, events, stream };
    };
    const stopWatch = async (watch: Awaited<ReturnType<typeof startWatch>>) => {
      if (watch.child.exitCode === null && watch.child.signalCode === null) {
        const stopped = once(watch.child, "exit");
        watch.child.kill("SIGKILL");
        await stopped;
      }
      watch.stream.close();
      watchers.delete(watch.child);
    };
    try {
      const wa = await startWatch(a);
      const wb = await startWatch(b);
      await writeFile(join(a.root, "watch.txt.tmp"), "automatic atomic save");
      const { rename } = await import("node:fs/promises");
      await rename(join(a.root, "watch.txt.tmp"), join(a.root, "watch.txt"));
      await expect
        .poll(async () => readFile(join(b.root, "watch.txt"), "utf8").catch(() => "missing"), {
          timeout: 25_000,
        })
        .toBe("automatic atomic save");
      wa.events.length = 0;
      await writeFile(join(a.root, "watch.txt"), "saved before watcher SIGKILL");
      await expect
        .poll(() => wa.events.find((event) => event.event === "saved_locally")?.revision_id, {
          timeout: 10_000,
        })
        .toBeDefined();
      const saved = wa.events.find((event) => event.event === "saved_locally")?.revision_id;
      if (!saved) throw new Error("Missing durable watcher observation");
      await stopWatch(wa);
      const restarted = await startWatch(a);
      await expect
        .poll(async () => readFile(join(b.root, "watch.txt"), "utf8"), { timeout: 25_000 })
        .toBe("saved before watcher SIGKILL");
      expect(text((await revision(saved)).tree, "watch.txt")).toBe("saved before watcher SIGKILL");
      await expect
        .poll(
          async () => {
            const head = await current();
            if (head === null) return false;
            const currentTree = (await revision(head)).revision.tree;
            const synchronized = await Promise.all(
              [a, b].map(async (device) => {
                const document = Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({
                      backups: Schema.optionalKey(
                        Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
                      ),
                      workspaces: Schema.Record(
                        Schema.String,
                        Schema.Record(
                          Schema.String,
                          Schema.Struct({
                            _tag: Schema.String,
                            base: Schema.NullOr(Schema.String),
                          }),
                        ),
                      ),
                    }),
                  ),
                )(await readFile(join(device.home, "author-sync.json"), "utf8"));
                const synchronized = Object.values(document.workspaces).some((entries) =>
                  Object.values(entries).some(
                    (checkpoint) => checkpoint._tag === "Idle" && checkpoint.base === head,
                  ),
                );
                const acknowledgements = Object.values(document.backups ?? {}).flatMap((entries) =>
                  Object.values(entries),
                );
                const backedUp = await Promise.all(
                  acknowledgements.map(
                    async (id) => (await revision(id)).revision.tree === currentTree,
                  ),
                );
                return synchronized && backedUp.some(Boolean);
              }),
            );
            return synchronized.every(Boolean);
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      expect(
        [wb, restarted].every((watch) =>
          watch.events.every((event) => event.result?.status !== "up_to_date"),
        ),
      ).toBe(true);
      const quiet = await revisionCount();
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      expect(await revisionCount()).toBe(quiet);
    } finally {
      for (const child of watchers) {
        if (child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, "exit");
          child.kill("SIGKILL");
          await stopped;
        }
      }
    }
    await writeFile(join(a.root, "skit.json"), "{ broken descriptor");
    expect(await run(a, "sync")).toMatchObject({ _tag: "Success" });
    const invalid = await current();
    if (invalid === null) throw new Error("Invalid authored content did not become current");
    const invalidRevision = await revision(invalid);
    expect(text(invalidRevision.tree, "skit.json")).toBe("{ broken descriptor");
    expect(invalidRevision.diagnostics.some(({ severity }) => severity === "error")).toBe(true);
    await symlink("missing-target", join(a.root, "pointer"));
    const linked = Schema.decodeUnknownSync(Captured)(await run(a, "capture"));
    expect(await run(a, "sync")).toMatchObject({ _tag: "Failure", failure: { tag: "TreeError" } });
    expect((await revision(linked.value.id)).tree.find(({ path }) => path === "pointer")).toEqual({
      path: "pointer",
      kind: "symlink",
      target: "missing-target",
    });
    expect(await current()).toBe(invalid);
    const counts = async () => ({
      revisions: await env.DB.prepare("SELECT COUNT(*) count FROM revisions").first<{
        count: number;
      }>(),
      blobs: (await env.SKIT_BLOBS.list()).objects.length,
    });
    const before = await counts();
    expect(before.blobs).toBeGreaterThan(0);
    expect(await run(a, "sync")).toMatchObject({ _tag: "Failure", failure: { tag: "TreeError" } });
    expect(await counts()).toEqual(before);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) count FROM releases").first<{ count: number }>())
        ?.count,
    ).toBe(0);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
