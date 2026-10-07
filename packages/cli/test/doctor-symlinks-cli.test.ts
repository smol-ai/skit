import { largeListingEntries } from "@smolai/skit-core";
import { it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { NodeServices } from "@effect/platform-node";
import { dirname, join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { expect, test } from "vitest";
import { outputContracts } from "../src/commands/output-contracts.js";

const bin = join(process.cwd(), "bin", "skit.js");
const name = "accelevents-api";
const document = `---\nname: ${name}\ndescription: Test the Accelevents API\n---\nFixture skill.\n`;
const envelope = Schema.Struct({
  schema: Schema.Literal(outputContracts.doctor.id),
  data: outputContracts.doctor.schema,
});

/** The CLI, filesystem, PATH probe, app-server transport and renderer are real; only discovery responses are controlled. */
function doctorJourney(nativeExecutable?: string, reportCanonical = true) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "skit-doctor-symlink-cli-" });
      const root = yield* fs.realPath(temporary);
      const nativeHome = join(root, "native-home");
      const library = join(root, "library");
      const source = join(nativeHome, "Work", "skills", name);
      const alias = join(nativeHome, ".codex", "skills", name);
      const copy = join(nativeHome, ".agents", "skills", name);
      const executables = join(root, "bin");
      const requests = join(root, "requests.jsonl");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.makeDirectory(dirname(alias), { recursive: true });
      yield* fs.makeDirectory(executables);
      yield* fs.writeFileString(join(source, "SKILL.md"), document);
      yield* fs.symlink(source, alias);
      if (nativeExecutable) {
        yield* fs.symlink(nativeExecutable, join(executables, "codex"));
      } else {
        yield* fs.writeFileString(
          join(executables, "codex"),
          `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
if (process.argv[2] !== 'app-server') process.exit(1);
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.DOCTOR_FIXTURE_REQUESTS, JSON.stringify(request) + '\\n');
  if (request.method === 'initialize') console.log(JSON.stringify({id: request.id, result: {}}));
  else if (request.method === 'skills/list') {
    if (!request.params.forceReload || request.params.cwds.length !== 1) process.exit(1);
    const skills = ['.codex', '.agents'].map(directory => {
      const document = path.join(process.env.HOME, directory, 'skills', ${JSON.stringify(name)}, 'SKILL.md');
      return {name: ${JSON.stringify(name)}, path: process.env.DOCTOR_FIXTURE_CANONICAL === 'true' ? fs.realpathSync(document) : document, scope: 'user', enabled: true, description: 'x'.repeat(800)};
    });
    console.log(JSON.stringify({id: request.id, result: {data: [{cwd: request.params.cwds[0], skills, errors: []}]}}));
  } else if (request.method === 'config/read') console.log(JSON.stringify({id: request.id, result: {config: {model: 'gpt-6.1-sol'}}}));
  else if (request.method !== 'initialized') process.exit(1);
});
`,
        );
        yield* fs.chmod(join(executables, "codex"), 0o755);
      }
      const env = {
        ...process.env,
        HOME: nativeHome,
        CODEX_HOME: join(nativeHome, ".codex"),
        XDG_CONFIG_HOME: join(nativeHome, ".config"),
        PATH: `${executables}:${dirname(process.execPath)}:/usr/bin:/bin`,
        DOCTOR_FIXTURE_REQUESTS: requests,
        DOCTOR_FIXTURE_CANONICAL: String(reportCanonical),
      };
      const command = (...args: string[]) =>
        spawnSync(process.execPath, [bin, ...args, "--home", library], {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 20_000,
        });
      const added = command("add", source, "--json");
      expect(added.status, added.stderr).toBe(0);
      const enabled = command("enable", name, "--allow-duplicate", "--json");
      expect(enabled.status, enabled.stderr).toBe(0);
      const json = command("doctor", "--json");
      expect(json.status, json.stderr).toBe(0);
      const report = Schema.decodeUnknownSync(envelope)(JSON.parse(json.stdout)).data;
      expect(report.codex.status, report.codex.detail).toBe("checked");
      expect(report.codex.errors).toEqual([]);
      expect(report.codex.findings).toHaveLength(1);
      const finding = report.codex.findings[0];
      expect(finding).toMatchObject({ kind: "duplicate-name", name, documents: "identical" });
      expect(finding.instances).toHaveLength(2);
      const linked = finding.instances.find(
        (instance) => instance.canonicalPath === join(source, "SKILL.md"),
      );
      expect(linked).toMatchObject({
        skitManaged: false,
        aliases: [{ path: alias, via: "symlink", linkPath: alias, linkTarget: source }],
      });
      expect(
        finding.instances.find((instance) => instance.canonicalPath === join(copy, "SKILL.md")),
      ).toMatchObject({ skitManaged: true, aliases: [{ path: copy, via: "directory" }] });
      expect(yield* fs.readLink(alias)).toBe(source);
      expect(yield* fs.readFileString(join(source, "SKILL.md"))).toBe(document);
      if (!nativeExecutable) {
        const budget = report.listing_budgets.find((budget) => budget.harness === "codex");
        expect(budget).toMatchObject({ _tag: "Estimated", limit: 7460, unit: "budget-tokens" });
        if (!budget) return yield* Effect.die("Missing Codex budget");
        expect(largeListingEntries(budget)).toHaveLength(2);
        const calls = (yield* fs.readFileString(requests))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((call) => call.method === "skills/list")).toHaveLength(1);
        expect(calls.filter((call) => call.method === "config/read")).toHaveLength(1);
      } else {
        expect(report.codex.version).toBeTruthy();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect.each([true, false])(
  "built doctor reports a symlink plus SKIT copy (native returns canonical paths: %s)",
  (canonical) => doctorJourney(undefined, canonical),
);

// Opt-in acceptance against an installed Codex binary, still with an isolated HOME and no model turns.
// SKIT_TEST_CODEX_EXECUTABLE=/absolute/path/to/codex pnpm exec vitest run --config vitest.subprocess.config.ts test/doctor-symlinks-cli.test.ts
const liveCodex = process.env.SKIT_TEST_CODEX_EXECUTABLE;
if (liveCodex) {
  it.effect("built doctor reports the duplicate discovered by real Codex", () =>
    doctorJourney(liveCodex),
  );
} else {
  test.skip("built doctor reports the duplicate discovered by real Codex", () => {});
}
