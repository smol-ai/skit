import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { authLoginCliCommand } from "../src/registry/commands/auth-login.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { terminalPrompterLayer } from "../src/terminal/prompter.js";
import { rendererTestLayer } from "./helpers/renderer.js";

const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("../src/registry/commands/login.js", () => ({ authLoginCommand: login }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  login.mockReset();
});

it.effect("login uses local and global parsed JSON policy despite unrelated process argv", () =>
  Effect.gen(function* () {
    for (const key of [
      "SKIT_NO_INPUT",
      "CODEX_CI",
      "CODEX_THREAD_ID",
      "CLAUDECODE",
      "AI_AGENT",
      "CI",
    ] as const)
      vi.stubEnv(key, undefined);
    const originalArgs = process.argv;
    const streams = [process.stdin, process.stderr];
    const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
    login.mockImplementation(() => Effect.interrupt);
    try {
      for (const stream of streams)
        Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
      const cases = [
        { fullTree: false, argv: ["--json=true"], json: true },
        { fullTree: false, argv: ["--json=false"], json: false },
        { fullTree: true, argv: ["--json", "auth", "login"], json: true },
        { fullTree: true, argv: ["--json=true", "auth", "login"], json: true },
        { fullTree: true, argv: ["auth", "--json", "login"], json: true },
        { fullTree: true, argv: ["auth", "login", "--json"], json: true },
        { fullTree: true, argv: ["--json=false", "auth", "login"], json: false },
        { fullTree: true, argv: ["--no-json", "auth", "login"], json: false },
        { fullTree: true, argv: ["auth", "login", "--json=false"], json: false },
        { fullTree: true, argv: ["auth", "login"], json: false },
      ];
      for (const { fullTree, argv, json } of cases) {
        process.argv = [process.execPath, "unrelated", `--json=${!json}`];
        const command = fullTree
          ? runCommandTree(skitCommand, argv, "test")
          : runCommandTree(authLoginCliCommand, argv, "test");
        login.mockClear();
        yield* command.pipe(
          Effect.provide(
            Layer.mergeAll(registryHttpLayer(), terminalPrompterLayer, rendererTestLayer()).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
          Effect.exit,
        );
        expect(login, JSON.stringify(argv)).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ interactive: !json }),
        );
      }
    } finally {
      process.argv = originalArgs;
      streams.forEach((stream, index) => {
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
        else Reflect.deleteProperty(stream, "isTTY");
      });
    }
  }),
);
