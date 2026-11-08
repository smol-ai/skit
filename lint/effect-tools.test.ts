import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const oxlint = join(root, "scripts/oxlint.mjs");
const broken = `import { Effect } from "effect";
export const program = Effect.gen(function* () {
  Effect.succeed(1);
  yield* Effect.void;
});
export type Open = Record<string, any>;
`;
const fixed = broken
  .replace("  Effect.succeed(1);", "  yield* Effect.succeed(1);")
  .replace("export type Open = Record<string, any>;", "");

test("Library state spreads remain plain records while class spreads warn", async () => {
  const directory = await mkdtemp(join(root, "packages/devtools/.effect-spread-"));
  const file = join(directory, "sample.ts");
  const source = `import type { LibraryState } from "../../skit/src/library/library-state.js";
class Instance {
  value = "instance";
  method() { return this.value; }
}
export const copyState = (state: LibraryState) => ({ ...state });
export const copyInstance = (instance: Instance) => ({ ...instance });
`;
  try {
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({ extends: "../tsconfig.json", include: ["sample.ts"] }),
    );
    await writeFile(file, source);
    const result = spawnSync(process.execPath, [oxlint, "--format=json", file], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      diagnostics: Array<{
        code: string;
        severity: string;
        labels: Array<{ span: { offset: number; length: number } }>;
      }>;
    };
    expect(report.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(
      report.diagnostics
        .filter((item) => item.code === "typescript(no-misused-spread)")
        .map((item) => {
          const { offset, length } = item.labels[0].span;
          return source.slice(offset, offset + length);
        }),
    ).toEqual(["...instance"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface Diagnostic {
  code: string;
  severity: number;
}

test("CLI and editor report Effect and SKIT errors, then clear them after a fix", async () => {
  const directory = await mkdtemp(join(root, "packages/devtools/.effect-tools-"));
  const file = join(directory, "sample.ts");
  const uri = pathToFileURL(file).href;
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      extends: "../tsconfig.json",
      include: ["sample.ts"],
    }),
  );
  await writeFile(file, broken);
  const lint = () =>
    spawnSync(process.execPath, [oxlint, "--format=json", file], {
      cwd: root,
      encoding: "utf8",
    });
  const server = spawn(process.execPath, [oxlint, "--lsp"], { cwd: root });
  const send = (message: object) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    server.stdin.write(body);
  };
  let buffer = Buffer.alloc(0);
  let stderr = "";
  server.stderr.on("data", (data) => {
    stderr += data;
  });
  try {
    const failed = lint();
    expect(failed.status, failed.stderr).toBe(1);
    const report = JSON.parse(failed.stdout) as {
      diagnostics: Array<{ code: string; severity: string }>;
    };
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "effecttsgo(floating-effect)", severity: "error" }),
        expect.objectContaining({ code: "skit(no-record-any)", severity: "error" }),
      ]),
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`LSP diagnostics timed out: ${stderr}`)),
        20_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      server.once("error", finish);
      server.once("exit", (code) => {
        if (code !== 0) finish(new Error(`LSP exited ${code}: ${stderr}`));
      });
      server.stdout.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        while (true) {
          const separator = buffer.indexOf("\r\n\r\n");
          if (separator < 0) break;
          const length = Number(
            /Content-Length: (\d+)/i.exec(buffer.subarray(0, separator).toString())?.[1],
          );
          if (buffer.length < separator + 4 + length) break;
          const message = JSON.parse(
            buffer.subarray(separator + 4, separator + 4 + length).toString(),
          ) as {
            id?: number;
            method?: string;
            params?: { uri: string; version?: number; diagnostics: Array<Diagnostic> };
          };
          buffer = buffer.subarray(separator + 4 + length);
          if (message.id === 1) {
            send({ method: "initialized", params: {} });
            send({
              method: "textDocument/didOpen",
              params: {
                textDocument: { uri, languageId: "typescript", version: 1, text: broken },
              },
            });
          }
          if (message.method === "textDocument/publishDiagnostics" && message.params?.uri === uri) {
            const { diagnostics, version } = message.params;
            if (
              version === 1 &&
              diagnostics.some((item) => item.code === "effecttsgo(floating-effect)")
            ) {
              try {
                expect(diagnostics).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ code: "effecttsgo(floating-effect)", severity: 1 }),
                    expect.objectContaining({ code: "skit(no-record-any)", severity: 1 }),
                  ]),
                );
                send({
                  method: "textDocument/didChange",
                  params: {
                    textDocument: { uri, version: 2 },
                    contentChanges: [{ text: fixed }],
                  },
                });
              } catch (error) {
                finish(error as Error);
              }
            }
            if (version === 2) {
              try {
                expect(diagnostics.filter((item) => item.severity === 1)).toEqual([]);
                finish();
              } catch (error) {
                finish(error as Error);
              }
            }
          }
          if (message.method && message.id !== undefined) send({ id: message.id, result: null });
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri: pathToFileURL(root).href,
          capabilities: {},
          workspaceFolders: [{ uri: pathToFileURL(root).href, name: "skit" }],
        },
      });
    });
    await writeFile(file, fixed);
    const passed = lint();
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);
  } finally {
    send({ id: 2, method: "shutdown", params: null });
    send({ method: "exit", params: null });
    server.stdin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
