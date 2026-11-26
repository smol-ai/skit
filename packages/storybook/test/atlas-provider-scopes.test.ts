import { expect, it } from "vitest";
import { Schema } from "effect";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { compilerProgram } from "../src/atlas/effect-graph/src/indexer/compiler-program.ts";
import { serviceDeclarations } from "../src/atlas/effect-graph/src/indexer/services.ts";
import { commandQueries } from "../src/atlas/effect-graph/src/indexer/commands.ts";
import { providerScopes } from "../src/atlas/effect-graph/src/indexer/provider-scopes.ts";
import { probeTypeFacts } from "../src/atlas/effect-graph/scripts/lib/type-facts.ts";
import { graphCompilerVersions } from "../src/atlas/effect-graph/scripts/lib/graph-compiler.ts";
import { LayerTypeFacts } from "../src/atlas/effect-graph/src/indexer/layer-type-facts.ts";

it("reads inherited command scopes, runtime scopes and conditional alternatives with the native compiler", () => {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const path = "packages/cli/src/main.ts";
  const compiled = compilerProgram(
    root,
    [
      {
        path,
        text: `
    import { Context, Effect, Layer } from "effect";
    import { Command } from "effect/cli";
    import { NodeRuntime } from "@effect/platform-node";
    /** A source-written fixture service. */
    class Tag extends Context.Service<Tag, {}>()("fixture/Tag") {}
    const live = Layer.succeed(Tag, {});
    const fixture = Layer.succeed(Tag, {});
    const leaf = Command.make("run", {}, () => Effect.asVoid(Tag)).pipe(Command.provide(live));
    export const tree = Command.make("skit").pipe(Command.withSubcommands([leaf]),
      Command.provide(() => process.env.MODE ? live : fixture),
      Command.provide(Layer.unwrap(Effect.map(Tag, () => live))));
    const program = Effect.void.pipe(Effect.provide(live));
    NodeRuntime.runMain(program);
  `,
      },
      {
        path: "packages/cli/tsconfig.json",
        text: JSON.stringify({
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            skipLibCheck: true,
            types: ["node"],
          },
          files: ["src/main.ts"],
        }),
      },
    ],
    { pinnedConfiguration: true },
  );
  try {
    expect(
      serviceDeclarations(compiled).find((service) => service.name === "Tag")?.description,
    ).toBe("A source-written fixture service.");
    const commands = commandQueries(compiled, path, "tree");
    expect(commands.map((command) => command.command)).toEqual(["run"]);
    expect(commands[0]?.scopes.map((scope) => scope.name)).toEqual([
      "live",
      "() => process.env.MODE ? live : fixture",
      "Layer.unwrap(Effect.map(Tag, () => live))",
    ]);
    const scopes = providerScopes(
      compiled,
      [path],
      commands.flatMap((command) => command.scopes),
    );
    expect(scopes.application.map((scope) => scope.name)).toEqual(["live"]);
    const configs = [
      ...new Set(scopes.queries.flatMap((query) => compiled.configFor(query.file) ?? [])),
    ];
    const facts = Schema.decodeUnknownSync(LayerTypeFacts)(
      probeTypeFacts({
        repo: root,
        repoName: "fixture",
        head: "fixture",
        dirty: true,
        extractor: { fingerprint: "fixture", files: {}, packages: {} },
        compact: true,
        queries: scopes.queries,
        projectFor: compiled.configFor,
        projectOf: compiled.openProjects(configs),
        projectPaths: configs,
        toolchainVersions: graphCompilerVersions(),
        textOf: (file) => compiled.program.textAt(file) ?? "",
      }),
    );
    const conditional = facts.composition?.nodes.find(
      (node) => node.label === "process.env.MODE ? live : fixture",
    );
    expect(
      facts.composition?.edges.filter(
        (edge) => edge.relationship === "returned" && edge.from === conditional?.id,
      ),
    ).toHaveLength(2);
    const tag = facts.types.find((type) => type.name === "Tag")?.id;
    expect(
      facts.composition?.nodes.find((node) => node.combinator === "unwrap")?.outerRequires,
    ).toEqual([tag]);
    expect(facts.composition?.anchors).toHaveLength(scopes.queries.length);
  } finally {
    compiled.close();
  }
});
