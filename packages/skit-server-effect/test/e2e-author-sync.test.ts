import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Effect, Layer, Schema } from "effect";
import { createServer } from "node:net";
import { authorLayer, initializeAuthorWorkspace } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
import { skitLayer, skitConfigurationLayer, sqliteLayer } from "@smolai/skit-core/platform";
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
      const stopped = once(interrupted, "exit", { signal: AbortSignal.timeout(5000) });
      expect(interrupted.kill("SIGKILL")).toBe(true);
      expect(await stopped).toEqual([null, "SIGKILL"]);
    } finally {
      lines.close();
      if (interrupted.exitCode === null && interrupted.signalCode === null) {
        const stopped = once(interrupted, "exit", { signal: AbortSignal.timeout(5000) });
        interrupted.kill("SIGKILL");
        await stopped;
      }
    }
    const acceptedCount = await revisionCount();
    expect(acceptedCount).toBeDefined();
    expect(await run(a, "sync")).toMatchObject({ _tag: "Success", value: { status: "pushed" } });
    // Replaying the raw observation is idempotent: only the separate canonical revision is new.
    expect(await revisionCount()).toBe((acceptedCount ?? 0) + 1);
    expect(text((await revision(interruptedObservation.value.id)).tree, "crash.txt")).toBe(
      "kept after SIGKILL",
    );
    expect(await run(b, "sync")).toMatchObject({ _tag: "Success" });
    expect(await readFile(join(b.root, "crash.txt"), "utf8")).toBe("kept after SIGKILL");
    // Exercise the shipped foreground command in separate background processes. Assertions
    // read real guest files and the Worker/D1/R2 Registry, rather than accepting log messages
    // as proof of convergence. Linux CI exercises the real filesystem event backend.
    const command = resolve(serverRoot, "../cli/bin/skit.js");
    const roots = (device: typeof a) => ({
      home: join(device.home, "device"),
      configHome: join(device.home, "device", ".config"),
      overrides: {},
    });
    const owners = (device: typeof a) =>
      Library.layer({ home: device.home, roots: roots(device) }).pipe(
        Layer.provideMerge(authorLayer({ home: device.home })),
        Layer.provideMerge(skitConfigurationLayer(device.home)),
        Layer.provideMerge(skitLayer),
      );
    const installed = (device: typeof a, name: string) =>
      readFile(join(device.home, "device", ".agents", "skills", name, "SKILL.md"), "utf8");
    const skill = (name: string, body: string) =>
      `---\nname: ${name}\ndescription: Watcher proof ${name}.\nmetadata:\n  opencode/autoinvoke: "false"\ntriggers: [ user ]\ndisable-model-invocation: true\n---\n# ${body}\n`;
    for (const device of [a, b]) {
      await mkdir(join(device.root, "skills", "review"), { recursive: true });
      await mkdir(join(device.root, "skills", "other"), { recursive: true });
      await writeFile(
        join(device.root, "skills/review/SKILL.md"),
        skill("review", "initial review"),
      );
      await writeFile(join(device.root, "skills/other/SKILL.md"), skill("other", "initial other"));
      await writeFile(
        join(device.root, "skit.json"),
        JSON.stringify({
          slug: "tools",
          skills: [
            {
              name: "review",
              path: "skills/review",
              invocation: "explicit",
              capabilities: ["filesystem_read"],
            },
            {
              name: "other",
              path: "skills/other",
              invocation: "explicit",
              capabilities: ["filesystem_read"],
            },
          ],
        }),
      );
      // One-time registration/selection only; changes below are driven by background watchers.
      // oxlint-disable-next-line skit/no-nested-runtime -- Node test bootstrap through real owners.
      await Effect.runPromise(
        Effect.gen(function* () {
          const imported = yield* initializeAuthorWorkspace(device.root, device.home);
          const owner = yield* Library.Service;
          const plan = yield* owner.plan(
            {
              _tag: "Enabled",
              changes: [
                {
                  _tag: "Enable",
                  subject: { _tag: "Collection", id: imported.entry.collection.collection_id },
                  members: "whole",
                  where: [{ kind: "global" }],
                },
              ],
            },
            { base: yield* owner.read },
          );
          yield* owner.apply({ _tag: "Apply", plan });
        }).pipe(Effect.provide(owners(device)), Effect.scoped),
      );
    }
    const portReservation = createServer();
    portReservation.listen(0, "127.0.0.1");
    await once(portReservation, "listening", { signal: AbortSignal.timeout(5000) });
    const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
      portReservation.address(),
    );
    await new Promise<void>((resolveClose) => portReservation.close(() => resolveClose()));
    const offlineOrigin = `http://127.0.0.1:${port}`;

    const watchers = new Set<ReturnType<typeof spawn>>();
    const startWatch = async (
      device: typeof a,
      mode: "cli" | "watch-offline" | "watch-hold-post" = "cli",
    ) => {
      const child = spawn(
        process.execPath,
        mode === "cli"
          ? [command, "author", "watch", device.root, "--home", device.home, "--json"]
          : [client, mode, device.root, device.home, "connected", "author-proof/tools"],
        {
          env: {
            ...process.env,
            SKIT_SERVER_URL: url.origin,
            HOME: join(device.home, "device"),
            XDG_CONFIG_HOME: join(device.home, "device", ".config"),
            XDG_STATE_HOME: join(device.home, "device", ".local", "state"),
            SKIT_TOKEN: token,
            SKIT_TEST_OFFLINE_ORIGIN: offlineOrigin,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      watchers.add(child);
      const output: string[] = [];
      const events: Array<{
        event: string;
        revision_id?: string;
        paths?: readonly string[];
        result?: { status: string; revision_id?: string };
      }> = [];
      const stream = createInterface({ input: child.stdout });
      stream.on("line", (line) => {
        output.push(line);
        const message = JSON.parse(line);
        if (message.data !== undefined) events.push(message.data);
      });
      child.stderr.on("data", (chunk) => output.push(String(chunk)));
      await expect
        .poll(
          () => {
            expect(child.exitCode, output.join("\n")).toBeNull();
            expect(child.signalCode, output.join("\n")).toBeNull();
            return (
              events.some((event) => event.event === "watching") &&
              events.some((event) => event.event === "installation")
            );
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      return { child, events, stream };
    };
    const stopWatch = async (watch: Awaited<ReturnType<typeof startWatch>>) => {
      if (watch.child.exitCode === null && watch.child.signalCode === null) {
        const stopped = once(watch.child, "exit", { signal: AbortSignal.timeout(5000) });
        expect(watch.child.kill("SIGKILL")).toBe(true);
        expect(await stopped).toEqual([null, "SIGKILL"]);
      }
      watch.stream.close();
      watchers.delete(watch.child);
    };
    const settled = async (completed: readonly Awaited<ReturnType<typeof startWatch>>[] = []) => {
      const head = await current();
      if (head === null) return false;
      // A sync receipt is emitted only after the final observed-tree backup POST completes.
      // Bytes alone may converge while that POST is still pending. Receipts are readiness;
      // Registry rows and the disk comparisons below remain the actual proof.
      if (
        completed.some(
          (watch) =>
            watch.events.findLast((event) => event.event === "sync")?.result?.revision_id !== head,
        )
      )
        return false;
      const stored = await revision(head);
      for (const device of [a, b]) {
        for (const entry of stored.tree) {
          if (entry.kind !== "file") continue;
          const bytes = await readFile(join(device.root, entry.path)).catch(() => undefined);
          if (bytes === undefined || !bytes.equals(Buffer.from(entry.bytes))) return false;
        }
      }
      return (await current()) === head;
    };
    const savedSignal = async (watch: Awaited<ReturnType<typeof startWatch>>, path: string) => {
      await expect
        .poll(
          () =>
            watch.events.some(
              (event) => event.event === "saved_locally" && event.paths?.includes(path),
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      return Schema.decodeUnknownSync(History.RevisionId)(
        watch.events.findLast(
          (event) => event.event === "saved_locally" && event.paths?.includes(path),
        )?.revision_id,
      );
    };
    const storedCount = async (id: string) =>
      (
        await env.DB.prepare("SELECT COUNT(*) count FROM revisions WHERE revision_id=?")
          .bind(id)
          .first<{ count: number }>()
      )?.count;
    try {
      let wa = await startWatch(a);
      let wb = await startWatch(b);
      await expect.poll(() => settled(), { timeout: 25_000 }).toBe(true);
      await writeFile(join(a.root, "watch.txt.tmp"), "automatic atomic save");
      const { rename } = await import("node:fs/promises");
      await rename(join(a.root, "watch.txt.tmp"), join(a.root, "watch.txt"));
      await expect
        .poll(async () => readFile(join(b.root, "watch.txt"), "utf8"), { timeout: 25_000 })
        .toBe("automatic atomic save");

      // The shipped CLI watcher installs both the local change and the received change.
      const review = skill("review", "automatically installed");
      await writeFile(join(a.root, "skills/review/SKILL.md"), review);
      for (const device of [a, b]) {
        await expect.poll(() => installed(device, "review"), { timeout: 25_000 }).toBe(review);
      }
      const invalidReview = "# Invalid member without required frontmatter\n";
      const other = skill("other", "unrelated valid member advanced");
      await writeFile(join(a.root, "skills/review/SKILL.md"), invalidReview);
      await writeFile(join(a.root, "skills/other/SKILL.md"), other);
      for (const device of [a, b]) {
        await expect.poll(() => installed(device, "other"), { timeout: 25_000 }).toBe(other);
        expect(await installed(device, "review")).toBe(review);
        await expect
          .poll(() => readFile(join(device.root, "skills/review/SKILL.md"), "utf8"), {
            timeout: 25_000,
          })
          .toBe(invalidReview);
      }
      await expect
        .poll(
          async () => {
            const head = await current();
            return head === null
              ? undefined
              : text((await revision(head)).tree, "skills/review/SKILL.md");
          },
          { timeout: 25_000 },
        )
        .toBe(invalidReview);
      await writeFile(join(a.root, "skills/review/SKILL.md"), review);
      await expect
        .poll(async () => readFile(join(b.root, "skills/review/SKILL.md"), "utf8"), {
          timeout: 25_000,
        })
        .toBe(review);
      await expect.poll(() => settled(), { timeout: 25_000 }).toBe(true);
      await stopWatch(wa);
      await stopWatch(wb);

      // Stored remote metadata fixes the origin; use the approved production watcher owners in the existing fixture. Only their
      // HTTP destinations are redirected to the closed port; workspace/locator stay unchanged.
      wa = await startWatch(a, "watch-offline");
      wb = await startWatch(b, "watch-offline");
      const offlineHead = await current();
      wa.events.length = 0;
      wb.events.length = 0;
      const beforeA = Date.now();
      await writeFile(join(a.root, "offline-a.txt"), "disjoint A");
      await writeFile(join(a.root, "notes.txt"), "earlier observed A");
      const inputA = await savedSignal(wa, "notes.txt");
      const observedA = Date.now();
      const beforeB = Date.now();
      await writeFile(join(b.root, "offline-b.txt"), "disjoint B");
      await writeFile(join(b.root, "notes.txt"), "later observed B");
      const inputB = await savedSignal(wb, "notes.txt");
      const observedB = Date.now();
      expect(await current()).toBe(offlineHead);
      expect(await storedCount(inputA)).toBe(0);
      expect(await storedCount(inputB)).toBe(0);
      // Readiness events choose the interruption boundary only. Retained IDs, bytes and
      // pre-kill edit times are verified from the Registry AFTER both processes are killed.
      await stopWatch(wa);
      await stopWatch(wb);
      const restartedAt = Date.now();
      // B's later observation reaches the Registry first; A reconnects last.
      wb = await startWatch(b);
      await expect
        .poll(
          async () => {
            const head = await current();
            return head === null ? undefined : text((await revision(head)).tree, "notes.txt");
          },
          { timeout: 25_000 },
        )
        .toBe("later observed B");
      wa = await startWatch(a);
      for (const device of [a, b]) {
        await expect
          .poll(async () => readFile(join(device.root, "offline-a.txt"), "utf8"), {
            timeout: 25_000,
          })
          .toBe("disjoint A");
        await expect
          .poll(async () => readFile(join(device.root, "offline-b.txt"), "utf8"), {
            timeout: 25_000,
          })
          .toBe("disjoint B");
        await expect
          .poll(async () => readFile(join(device.root, "notes.txt"), "utf8"), { timeout: 25_000 })
          .toBe("later observed B");
      }
      const storedA = await revision(inputA);
      const storedB = await revision(inputB);
      for (const { stored, bytes, start, end } of [
        { stored: storedA, bytes: "earlier observed A", start: beforeA, end: observedA },
        { stored: storedB, bytes: "later observed B", start: beforeB, end: observedB },
      ]) {
        expect(text(stored.tree, "notes.txt")).toBe(bytes);
        expect(stored.revision.edits["notes.txt"]).toBeGreaterThanOrEqual(start);
        expect(stored.revision.edits["notes.txt"]).toBeLessThanOrEqual(end);
        expect(stored.revision.edits["notes.txt"]).toBeLessThan(restartedAt);
      }
      expect(text(storedA.tree, "offline-a.txt")).toBe("disjoint A");
      expect(text(storedB.tree, "offline-b.txt")).toBe("disjoint B");
      expect(storedB.revision.edits["notes.txt"]).toBeGreaterThan(
        storedA.revision.edits["notes.txt"],
      );
      const mergedHead = await current();
      expect(mergedHead).not.toBeNull();
      const merged = await revision(mergedHead ?? "");
      expect(merged.revision.parents).toHaveLength(2);
      const parents = await Promise.all(merged.revision.parents.map((id) => revision(id)));
      expect(parents.map((parent) => text(parent.tree, "notes.txt")).sort()).toEqual([
        "earlier observed A",
        "later observed B",
      ]);
      expect(
        parents.map((parent) => parent.revision.edits["notes.txt"]).sort((a, b) => a - b),
      ).toEqual([storedA.revision.edits["notes.txt"], storedB.revision.edits["notes.txt"]]);
      expect(text(merged.tree, "notes.txt")).toBe("later observed B");
      await expect.poll(() => settled(), { timeout: 25_000 }).toBe(true);
      await stopWatch(wa);

      // Accepted POST ambiguity uses the production watcher owner through the fixture,
      // not the shipped CLI process. The existing HTTP tap holds its accepted response.
      const beforeInterruptedWatch = await current();
      const interruptedWatch = await startWatch(a, "watch-hold-post");
      await writeFile(
        join(a.root, "watch-crash.txt"),
        "watcher bytes retained across ambiguous POST",
      );
      const saved = await savedSignal(interruptedWatch, "watch-crash.txt");
      await expect.poll(() => storedCount(saved), { timeout: 15_000 }).toBe(1);
      expect(text((await revision(saved)).tree, "watch-crash.txt")).toBe(
        "watcher bytes retained across ambiguous POST",
      );
      expect(await current()).toBe(beforeInterruptedWatch);
      await stopWatch(interruptedWatch);
      wa = await startWatch(a);
      await expect
        .poll(async () => readFile(join(b.root, "watch-crash.txt"), "utf8"), { timeout: 25_000 })
        .toBe("watcher bytes retained across ambiguous POST");
      await expect.poll(() => settled([wa, wb]), { timeout: 25_000 }).toBe(true);
      expect(await storedCount(saved)).toBe(1);
      // Take IDs and the count in one snapshot so every extra revision can be explained.
      const beforeWindow = (
        await env.DB.prepare(
          "SELECT revision_id,tree_hash,author_device,author_at,created_at FROM revisions ORDER BY created_at,revision_id",
        ).all<{
          revision_id: string;
          tree_hash: string;
          author_device: string;
          author_at: number;
          created_at: string;
        }>()
      ).results;
      const quiet = beforeWindow.length;
      const windowStartedAt = Date.now();
      const headBeforeWindow = await current();
      await new Promise((resolveWait) => setTimeout(resolveWait, 7_000));
      const afterWindow = (
        await env.DB.prepare(
          "SELECT revision_id,tree_hash,author_device,author_at,created_at FROM revisions ORDER BY created_at,revision_id",
        ).all<{
          revision_id: string;
          tree_hash: string;
          author_device: string;
          author_at: number;
          created_at: string;
        }>()
      ).results;
      const beforeIds = new Set(beforeWindow.map((row) => row.revision_id));
      const additions = [];
      for (const row of afterWindow.filter((row) => !beforeIds.has(row.revision_id))) {
        const stored = await revision(row.revision_id);
        const parentRevisions = await Promise.all(
          stored.revision.parents.map((id) => revision(id)),
        );
        additions.push({
          ...row,
          parents: stored.revision.parents,
          edits: stored.revision.edits,
          parentsKnownBeforeWindow: stored.revision.parents.map((id) => beforeIds.has(id)),
          parentTrees: parentRevisions.map((parent) => parent.revision.tree),
          parentAuthors: parentRevisions.map((parent) => parent.revision.author),
          parentEdits: parentRevisions.map((parent) => parent.revision.edits),
          treeEqualsAnyParent: parentRevisions.some(
            (parent) => parent.revision.tree === stored.revision.tree,
          ),
          treeKnownBeforeWindow: beforeWindow.some(
            (previous) => previous.tree_hash === stored.revision.tree,
          ),
        });
      }
      console.info(
        JSON.stringify({
          proof: "watcher-quiet-window",
          windowStartedAt,
          windowEndedAt: Date.now(),
          headBeforeWindow,
          headAfterWindow: await current(),
          heldId: saved,
          beforeCount: quiet,
          afterCount: afterWindow.length,
          additions,
          syncReceipts: [wa, wb].map((watch) =>
            watch.events.filter((event) => event.event === "sync").map((event) => event.result),
          ),
        }),
      );
      expect(await revisionCount()).toBe(quiet);
    } finally {
      for (const child of watchers) {
        if (child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, "exit", { signal: AbortSignal.timeout(5000) });
          child.kill("SIGKILL");
          await stopped;
        }
      }
    }
    await writeFile(join(a.root, "skit.json"), "{ broken descriptor");
    expect(await run(a, "sync")).toMatchObject({ _tag: "Success" });
    const invalid = await current();
    expect(invalid).not.toBeNull();
    const invalidRevision = await revision(invalid ?? "");
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
