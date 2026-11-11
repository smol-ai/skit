import { it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { Argument, Command, Flag, CliOutput } from "effect/cli";
import { expect } from "vitest";
import { defineCommand, withSharedFlags, GlobalParameters } from "../src/commands/definition.js";
import { jsonFlag, JsonOutputFlag } from "../src/commands/parameters.js";
import { CommandMetadata } from "../src/commands/metadata.js";
import { commandDocuments } from "../src/commands/manifest.js";
import { cliLayer } from "../src/application.js";
import { skitCommand } from "../src/commands/tree.js";

it.effect(
  "documents the same aliases, choices, defaults and repeat limits the parser enforces",
  () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const probe = defineCommand(
        "probe",
        {
          subject: Argument.String("subject").pipe(
            Argument.withDescription("Subject to inspect."),
            Argument.optional,
          ),
          mode: Flag.Literals("mode", ["fast", "safe"]).pipe(
            Flag.withAlias("m"),
            Flag.withDefault("safe"),
            Flag.withDescription("Inspection mode."),
          ),
          tag: Flag.String("tag").pipe(
            Flag.between(1, 2),
            Flag.withDescription("One or two labels."),
          ),
          verbose: Flag.Boolean("verbose").pipe(
            Flag.withDefault(false),
            Flag.withDescription("Show detail."),
          ),
        },
        (input) =>
          Effect.sync(() => {
            seen.push(input);
          }),
      ).pipe(Command.annotate(CommandMetadata, { interactive: false, outputSchemas: [] }));
      const root = Command.make("skit").pipe(
        withSharedFlags({
          home: Flag.String("home").pipe(Flag.optional, Flag.withDescription("State directory.")),
        }),
        Command.withSubcommands([probe]),
      );
      const [document] = yield* commandDocuments(root);
      expect(seen).toEqual([]);
      expect(document?.invocation.missing).toEqual([]);
      expect(document?.invocation.arguments).toMatchObject([
        { name: "subject", required: false, min: 0, max: 1, description: "Subject to inspect." },
      ]);
      expect(document?.invocation.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "mode",
            aliases: ["-m"],
            choices: ["fast", "safe"],
            default: { status: "value", value: '"safe"' },
            scope: "local",
          }),
          expect.objectContaining({ name: "tag", repeated: true, required: true, min: 1, max: 2 }),
          expect.objectContaining({
            name: "verbose",
            negation: "--no-verbose",
            default: { status: "value", value: "false" },
          }),
          expect.objectContaining({ name: "home", scope: "inherited" }),
          expect.objectContaining({ name: "help", scope: "global", aliases: ["-h"] }),
        ]),
      );
      const run = Command.runWith(root, { version: "test", renderErrors: false });
      yield* run(["probe", "-m", "fast", "--tag", "one", "--tag", "two", "--no-verbose"]);
      expect(seen).toEqual([
        { subject: Option.none(), mode: "fast", tag: ["one", "two"], verbose: false },
      ]);
      for (const args of [
        ["probe", "--mode", "invalid", "--tag", "one"],
        ["probe"],
        ["probe", "--tag", "one", "--tag", "two", "--tag", "three"],
      ]) {
        expect((yield* Effect.result(run(args)))._tag).toBe("Failure");
      }
      expect(seen).toHaveLength(1);
      yield* run(["probe", "--tag", "one"]);
      expect(seen[1]).toEqual({
        subject: Option.none(),
        mode: "safe",
        tag: ["one"],
        verbose: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "one shared global flag has one row, while a distinct local override preserves token placement",
  () =>
    Effect.gen(function* () {
      const seen: { version: string; json: boolean }[] = [];
      const versions: string[] = [];
      const publish = defineCommand(
        "publish",
        {
          json: jsonFlag,
          version: Flag.String("version").pipe(Flag.withDescription("Release version.")),
        },
        (input) =>
          Effect.sync(() => {
            seen.push(input);
          }),
      ).pipe(Command.annotate(CommandMetadata, { interactive: false, outputSchemas: [] }));
      const root = Command.make("skit").pipe(
        Command.withGlobalFlags([JsonOutputFlag]),
        Command.annotate(GlobalParameters, [JsonOutputFlag]),
        Command.withSubcommands([publish]),
      );
      const [document] = yield* commandDocuments(root);
      expect(document?.invocation.options.filter((option) => option.name === "json")).toMatchObject(
        [{ scope: "global" }],
      );
      const options = document!.invocation.options.filter((option) => option.name === "version");
      expect(options).toMatchObject([
        { scope: "local", type: "string", required: true },
        {
          scope: "global",
          type: "boolean",
          aliases: ["-v"],
          shadowedTokens: ["--version"],
          beforeCommandExample: "skit --version publish",
        },
      ]);
      const run = Command.runWith(root, { version: "test-version", renderErrors: false });
      yield* run(["publish", "--version", "1.2.3", "--json"]);
      expect(seen).toEqual([{ version: "1.2.3", json: true }]);
      const presenter: CliOutput.Presenter = {
        present: (event) =>
          Effect.sync(() => {
            if (event._tag === "Version") versions.push(event.version);
          }),
      };
      yield* run(["--version", "publish"]).pipe(
        Effect.provideService(CliOutput.Presenter, presenter),
      );
      yield* run(["publish", "-v"]).pipe(Effect.provideService(CliOutput.Presenter, presenter));
      yield* run(["publish", "--no-version"]).pipe(
        Effect.provideService(CliOutput.Presenter, presenter),
      );
      yield* run(["--version=false", "publish"]).pipe(
        Effect.provideService(CliOutput.Presenter, presenter),
      );
      expect(versions).toEqual(["test-version", "test-version", "test-version", "test-version"]);
      expect(seen).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "every executable SKIT command retains its parameters and documents inherited and global flags",
  () =>
    Effect.gen(function* () {
      const documents = yield* commandDocuments(skitCommand);
      expect(documents).toHaveLength(41);
      for (const document of documents) {
        expect(document.invocation.missing, document.path.join(" ")).toEqual([]);
        expect(
          document.invocation.arguments.every((argument) => argument.description.length > 0),
          document.path.join(" "),
        ).toBe(true);
      }
      for (const document of documents) {
        expect(
          document.invocation.options.every((option) => option.description.length > 0),
          document.path.join(" "),
        ).toBe(true);
        expect(
          document.invocation.options.filter((option) => option.name === "json"),
        ).toMatchObject([{ scope: "global" }]);
      }
      const update = documents.find((document) => document.path.join(" ") === "update")!;
      expect(update.invocation.handlerRules).toContain("skit update --from requires <skill>");
      const publish = documents.find((document) => document.path.join(" ") === "author publish")!;
      expect(
        publish.invocation.options.find(
          (option) => option.name === "version" && option.scope === "global",
        ),
      ).toMatchObject({
        shadowedTokens: ["--version"],
        beforeCommandExample: "skit --version author publish",
      });
      const doctor = documents.find((document) => document.path.join(" ") === "doctor")!;
      expect(doctor.invocation.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "days",
            default: { status: "value", value: "14" },
            missing: ["Additional parser checks are not documented."],
          }),
          expect.objectContaining({ name: "devin-root", repeated: true, min: 0 }),
        ]),
      );
      const repository = documents.find(
        (document) => document.path.join(" ") === "repository ignore",
      )!;
      expect(repository.invocation.arguments).toMatchObject([{ name: "path", required: true }]);
      expect(repository.invocation.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "home", scope: "inherited" }),
          expect.objectContaining({ name: "json", scope: "global" }),
        ]),
      );
      const usage = documents.find((document) => document.path.join(" ") === "usage")!;
      expect(usage.invocation.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "harness",
            choices: expect.arrayContaining(["all", "codex"]),
          }),
        ]),
      );
    }).pipe(Effect.provide(cliLayer(false, "/tmp/skit-invocation-document-test"))),
);
