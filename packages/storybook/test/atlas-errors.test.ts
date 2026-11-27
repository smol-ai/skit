import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { inspectErrors } from "../src/atlas/errors.ts";

it("follows CLI imports, service interface unions and aliases, retaining errors without presenters", () => {
  const root = mkdtempSync(join(tmpdir(), "skit-atlas-errors-"));
  try {
    const write = (path: string, source: string) => {
      const file = join(root, path);
      mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      writeFileSync(file, source);
      return file;
    };
    const failures = write(
      "packages/skit/src/failures.ts",
      `
      export class Busy extends Schema.TaggedError<Busy>()("Busy", { path: Schema.String }) {}
      export class Hidden extends Data.TaggedError("Owner.Hidden")<{}> {}
      export type Failure = Busy | Hidden;
    `,
    );
    const service = write(
      "packages/skit/src/owner.ts",
      `
      import type { Failure } from "./failures.js";
      interface Shape { readonly save: Effect.Effect<void, Failure> }
      export class Owner extends Context.Service<Owner, Shape>()("Owner") {}
    `,
    );
    const cli = write(
      "packages/cli/src/main.ts",
      `import { Owner } from "../../skit/src/owner.js";`,
    );
    const presentation = write(
      "packages/cli/src/owner-failures.ts",
      `
      import { Busy as OwnerBusy } from "../../skit/src/failures.js";
      export const busy = (error: OwnerBusy) => "Please retry after the other writer finishes.";
      export const fail = () => Effect.fail(new OwnerBusy({ path: "/state" }));
    `,
    );
    const server = write(
      "packages/server/src/failures.ts",
      `
      export class ServerOnly extends Schema.TaggedError<ServerOnly>()("ServerOnly", {}) {}
    `,
    );
    const program = ts.createProgram([failures, service, cli, presentation, server], {
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      noLib: true,
    });
    const errors = inspectErrors(program, root);
    expect(errors.map((error) => error.name).sort()).toEqual(["Busy", "Hidden"]);
    const busy = errors.find((error) => error.name === "Busy")!;
    expect(busy.services).toEqual(["Owner (packages/skit/src/owner.ts)"]);
    expect(busy.definition).toContain("path: Schema.String");
    expect(busy.category).toBe("Operational failure");
    expect(busy.evidence[0]?.kind).toBe("Checked failure");
    expect(busy.presentations[0]?.source).toContain("Please retry");
    const hidden = errors.find((error) => error.name === "Hidden")!;
    expect(hidden.tag).toBe("Owner.Hidden");
    expect(hidden.services).toEqual(busy.services);
    expect(hidden.presentations).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("classifies checked, defective, mixed and stored uses with source evidence and leaves unknowns visible", () => {
  const root = mkdtempSync(join(tmpdir(), "skit-atlas-error-uses-"));
  try {
    const file = join(root, "packages/cli/src/main.ts");
    mkdirSync(join(root, "packages/cli/src"), { recursive: true });
    writeFileSync(
      file,
      `
      class Input extends Schema.TaggedError<Input>()("Input", {}) { readonly code = "INVALID_ARGUMENT" as const }
      class InvalidData extends Schema.TaggedError<InvalidData>()("InvalidData", {}) { readonly code = "VALIDATION_FAILED" as const }
      class Busy extends Schema.TaggedError<Busy>()("Busy", {}) {}
      class Protocol extends Schema.TaggedError<Protocol>()("Protocol", {}) {}
      class Catalog extends Schema.TaggedError<Catalog>()("Catalog", {}) {}
      class Mixed extends Schema.TaggedError<Mixed>()("Mixed", {}) {}
      class Stored extends Schema.TaggedError<Stored>()("Stored", {}) {}
      class Unknown extends Schema.TaggedError<Unknown>()("Unknown", {}) {}
      class Constructed extends Schema.TaggedError<Constructed>()("Constructed", {}) {}
      class Incidental extends Schema.TaggedError<Incidental>()("Incidental", {}) {}
      type Expected = Busy | InvalidData;
      interface OwnerShape { run: () => Effect.Effect<void, Expected>; inspect: () => Effect.Effect<Incidental> }
      export class Owner extends Context.Service<Owner, OwnerShape>()("Owner") {}
      function* apply() {
        yield* new Input();
        yield* Effect.fail(new Mixed());
        yield* Effect.die(new Protocol());
        yield* Effect.die(new Mixed());
      }
      function directory() { throw new Catalog(); }
      const native = new Constructed();
      const codec = SchemaGetter.transform((old) => { return new Stored(old); });
      // A story or a class name alone cannot prove a production use.
    `,
    );
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ESNext, noLib: true });
    const errors = inspectErrors(program, root);
    const categories = Object.fromEntries(errors.map((error) => [error.name, error.category]));
    expect(categories).toEqual({
      Input: "Input validation",
      InvalidData: "Input validation",
      Busy: "Operational failure",
      Protocol: "Internal defect",
      Catalog: "Internal defect",
      Mixed: "Mixed use",
      Stored: "Stored format conversion",
      Unknown: "Unclassified",
      Constructed: "Unclassified",
      Incidental: "Unclassified",
    });
    expect(errors.find((error) => error.name === "Mixed")!.evidence.map((use) => use.kind)).toEqual(
      ["Checked failure", "Defect"],
    );
    expect(errors.find((error) => error.name === "Protocol")!.evidence[0]).toMatchObject({
      kind: "Defect",
      file: "packages/cli/src/main.ts",
      source: "Effect.die(new Protocol())",
    });
    expect(errors.find((error) => error.name === "Stored")!.evidence[0]?.kind).toBe(
      "Stored conversion",
    );
    expect(errors.find((error) => error.name === "Unknown")!.evidence).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
