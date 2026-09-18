import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Context, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { expect } from "vitest";
import { commandApplicationLayer } from "../src/application.js";
import { helpDocument } from "../src/commands/help-document.js";
import { commandDescriptions } from "../src/commands/manifest.js";
import { skitCommand } from "../src/commands/tree.js";

const Contract = Context.Service<never, string>("test/Contract");

it.effect("captures Effect CLI's structured command model", () => {
  const add = Command.make("add", {
    source: Argument.string("source"),
    version: Flag.string("version").pipe(
      Flag.withDescription("Select a source version."),
      Flag.optional,
    ),
  }).pipe(
    Command.withDescription("Add a source."),
    Command.withExamples([{ command: "skit add owner/repository" }]),
    Command.annotate(Contract, "skit.add.v1"),
  );
  const root = Command.make("skit").pipe(Command.withSubcommands([add]));

  return Effect.gen(function* () {
    const document = yield* helpDocument(root, ["add"]);

    expect(document.description).toBe("Add a source.");
    expect(document.usage).toBe("skit add [flags] <source>");
    expect(document.args).toEqual([
      {
        name: "source",
        type: "string",
        description: Option.none(),
        required: true,
        variadic: false,
      },
    ]);
    expect(document.flags).toEqual([
      {
        name: "version",
        aliases: [],
        type: "string",
        description: Option.some("Select a source version."),
        required: false,
      },
    ]);
    expect(document.examples).toEqual([{ command: "skit add owner/repository" }]);
    expect(Context.get(document.annotations, Contract)).toBe("skit.add.v1");
  }).pipe(Effect.provide(NodeServices.layer));
});

it.effect("derives the public manifest from executable leaves", () =>
  Effect.gen(function* () {
    const manifest = yield* commandDescriptions(skitCommand);

    expect(manifest.map((command) => command.path.join(" "))).toEqual([
      "auth login",
      "auth logout",
      "auth status",
      "add",
      "check",
      "doctor",
      "disable",
      "enable",
      "inventory",
      "library history",
      "list",
      "pin",
      "pull",
      "registry add",
      "registry default",
      "registry list",
      "registry remove",
      "repository list",
      "repository watch",
      "repository ignore",
      "repository forget",
      "remove",
      "security accept",
      "security review",
      "server bootstrap",
      "setup",
      "sync",
      "update",
      "version",
    ]);
  }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-manifest-test"))),
);
