import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Schema } from "effect";
import { copySkitFixture } from "./helpers/skit-fixture.js";

const bin = join(process.cwd(), "bin", "skit.js");
const PackageDocument = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const StateBindingsDocument = Schema.fromJsonString(
  Schema.Struct({ global_bindings: Schema.Array(Schema.Unknown) }),
);
const ProjectionRetentionPlanDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.update.projection-retention.plan.v1"),
    data: Schema.Struct({
      skill_id: Schema.String,
      previous_skill_version_id: Schema.String,
      selected_projection_id: Schema.String,
      observed_digest: Schema.String,
      snapshot_digest: Schema.String,
      retained_path: Schema.String,
      projections: Schema.Array(
        Schema.Struct({
          projection_id: Schema.String,
          harness: Schema.String,
          path: Schema.String,
          observed_digest: Schema.String,
          agreement: Schema.String,
        }),
      ),
    }),
  }),
);
const ProjectionRetentionResultDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.update.projection-retention.v1"),
    data: Schema.Struct({
      previous_skill_version_id: Schema.String,
      retained_skill_version_id: Schema.String,
      retained_copy_id: Schema.String,
      snapshot_digest: Schema.String,
      retained: Schema.Boolean,
      projections: Schema.Array(
        Schema.Struct({ harness: Schema.String, path: Schema.String, status: Schema.String }),
      ),
    }),
  }),
);
const ProjectionRetentionStateDocument = Schema.fromJsonString(
  Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({
        skill_id: Schema.String,
        selected_skill_version_id: Schema.String,
        versions: Schema.Array(Schema.Struct({ skill_version_id: Schema.String })),
      }),
    ),
    acquisitions: Schema.Array(
      Schema.Struct({
        source_identity: Schema.Unknown,
        input: Schema.Struct({ value: Schema.String }),
      }),
    ),
  }),
);
const DoctorDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.doctor.v2"),
    data: Schema.Struct({
      ok: Schema.Boolean,
      issues: Schema.Array(
        Schema.Struct({ code: Schema.String, path: Schema.optionalKey(Schema.String) }),
      ),
    }),
  }),
);
process.env.SKIT_VALIDATE_OUTPUT = "1";
process.env.SKIT_HOME = join(tmpdir(), `skit-cli-test-home-${process.pid}`);
afterAll(async () => rm(process.env.SKIT_HOME!, { recursive: true, force: true }));

describe("CLI contracts", () => {
  test("author-only commands do not exist at the root", () => {
    for (const command of ["init", "validate", "publish"]) {
      const result = spawnSync(process.execPath, [bin, command, "--json"], {
        encoding: "utf8",
      });
      expect(result.status).toBe(64);
      expect(JSON.parse(result.stderr).error).toEqual(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
    }
  });

  test("root help succeeds in human and JSON modes", () => {
    const human = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    expect(human.status).toBe(0);
    expect(human.stderr).toBe("");

    const machine = spawnSync(process.execPath, [bin, "--help", "--json"], {
      encoding: "utf8",
    });
    expect(machine.status).toBe(0);
    expect(machine.stderr).toBe("");
    expect(JSON.parse(machine.stdout)).toEqual(
      expect.objectContaining({ schema: "skit.help.v1", data: expect.any(Object) }),
    );
  });

  test("authentication status never prints credential material", async () => {
    const home = await mkdtemp(join(tmpdir(), "skit-auth-status-"));
    const status = spawnSync(process.execPath, [bin, "auth", "status", "--home", home, "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SKIT_SERVER_URL: "https://registry.test",
        SKIT_TOKEN: "skit_pat_do_not_print_this_secret",
      },
    });
    expect(status.status).toBe(0);
    const statusBody = JSON.parse(status.stdout);
    expect(statusBody).toMatchObject({
      schema: "skit.auth.status.v2",
      data: {
        credentials: [
          {
            origin: "https://registry.test",
            tokenPrefix: "skit_pat_do_not_pr",
            source: "environment",
          },
        ],
      },
    });
    expect(statusBody.data.credentials[0]).not.toHaveProperty("token");
  });

  test("login requires a terminal and never accepts a password option", () => {
    const nonInteractive = spawnSync(
      process.execPath,
      [bin, "auth", "login", "https://registry.test", "--json"],
      { encoding: "utf8" },
    );
    expect(nonInteractive.status).toBe(64);
    expect(JSON.parse(nonInteractive.stderr).error.message).toContain(
      "Interactive login requires a terminal",
    );

    const passwordFlag = spawnSync(
      process.execPath,
      [bin, "auth", "login", "https://registry.test", "--password", "secret", "--json"],
      { encoding: "utf8" },
    );
    expect(passwordFlag.status).toBe(64);
    expect(JSON.parse(passwordFlag.stderr).error).toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  test("corrupt authentication state does not brick local commands", async () => {
    const home = await mkdtemp(join(tmpdir(), "skit-auth-corrupt-"));
    await writeFile(join(home, "auth.json"), "not json");
    const list = spawnSync(process.execPath, [bin, "list", "--home", home, "--json"], {
      encoding: "utf8",
    });
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ schema: "skit.list.v2" });

    const add = spawnSync(
      process.execPath,
      [bin, "add", "skit:owner/skit", "--home", home, "--json"],
      { encoding: "utf8" },
    );
    expect(add.status).toBe(12);
    expect(JSON.parse(add.stderr).error.message).toContain(join(home, "auth.json"));

    const status = spawnSync(process.execPath, [bin, "auth", "status", "--home", home, "--json"], {
      encoding: "utf8",
    });
    expect(status.status).toBe(12);
    expect(JSON.parse(status.stderr).error.message).toContain(join(home, "auth.json"));
  });

  test("unknown commands preserve the structured JSON error contract", () => {
    const result = spawnSync(process.execPath, [bin, "bogus", "--json"], { encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual(
      expect.objectContaining({
        schema: "skit.error.v1",
        error: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      }),
    );
  });

  test("command help succeeds and remains structured under JSON", () => {
    const human = spawnSync(process.execPath, [bin, "add", "--help"], { encoding: "utf8" });
    expect(human.status).toBe(0);
    expect(human.stderr).toBe("");

    const machine = spawnSync(process.execPath, [bin, "add", "--help", "--json"], {
      encoding: "utf8",
    });
    expect(machine.status).toBe(0);
    expect(machine.stderr).toBe("");
    expect(JSON.parse(machine.stdout)).toEqual(
      expect.objectContaining({ schema: "skit.help.v1", data: expect.any(Object) }),
    );
  });

  test("rejects options that do not belong to the selected command", () => {
    const result = spawnSync(
      process.execPath,
      [bin, "list", "--json", "--for", "codex", "--revision", "zzz"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toEqual(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });

  test("reports the package version without interpreting it as a value flag", () => {
    const result = spawnSync(process.execPath, [bin, "version", "--json"], { encoding: "utf8" });
    const expected = Schema.decodeUnknownSync(PackageDocument)(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ).version;
    expect(result.status).toBe(0);
    expect(expected).toMatch(
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
    );
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "skit.version.v1",
      data: { version: expected },
    });
    expect(result.stderr).toBe("");
  });

  test("reviews and optionally accepts a retained finding without blocking Projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-security-cli-"));
    const source = join(root, "source");
    const home = join(root, "home");
    const codex = join(root, "codex");
    await copySkitFixture("hazardous", source);
    expect(
      spawnSync(process.execPath, [bin, "add", source, "--home", home], { encoding: "utf8" })
        .status,
    ).toBe(0);
    const reviewed = spawnSync(
      process.execPath,
      [bin, "security", "review", "review", "--home", home, "--json"],
      { encoding: "utf8" },
    );
    expect(reviewed.status).toBe(0);
    const review = JSON.parse(reviewed.stdout);
    expect(review.schema).toBe("skit.security.review.v1");
    const fingerprint = review.data.audit.findings[0].fingerprint as string;
    expect(review.data.assessment.outcome).toBe("warn");

    const enabled = spawnSync(
      process.execPath,
      [bin, "enable", "review", "--for", "codex", "--home", home, "--codex-root", codex, "--json"],
      { encoding: "utf8" },
    );
    expect(enabled.status).toBe(0);
    expect(JSON.parse(enabled.stdout)).toEqual(
      expect.objectContaining({
        schema: "skit.enable.v2",
        data: expect.objectContaining({ enabled: true }),
      }),
    );

    const accepted = spawnSync(
      process.execPath,
      [
        bin,
        "security",
        "accept",
        "review",
        "--home",
        home,
        "--finding",
        fingerprint,
        "--principal",
        "principal:test",
        "--rationale",
        "Reviewed exact invocation",
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(accepted.status).toBe(0);
    const acceptedReview = JSON.parse(accepted.stdout);
    expect(acceptedReview).toEqual(
      expect.objectContaining({
        schema: "skit.security.accept.v1",
        data: expect.objectContaining({
          assessment: expect.objectContaining({ outcome: "warn" }),
          acceptances: expect.arrayContaining([
            expect.objectContaining({
              fingerprint,
              principal: "principal:test",
              rationale: "Reviewed exact invocation",
              status: "applicable",
            }),
          ]),
        }),
      }),
    );
    expect(
      spawnSync(
        process.execPath,
        [bin, "enable", "review", "--for", "codex", "--home", home, "--codex-root", codex],
        { encoding: "utf8" },
      ).status,
    ).toBe(0);
    expect(acceptedReview.data.assessment.findingDecisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ fingerprint, disposition: "accepted" })]),
    );
  });

  test("list emits a versioned JSON envelope", async () => {
    const home = await mkdtemp(join(tmpdir(), "skit-cli-home-"));
    const result = spawnSync(process.execPath, [bin, "list", "--json", "--home", home], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "skit.list.v2",
      data: { collections: [], bindings: [] },
    });
    expect(result.stderr).toBe("");
  });

  test("doctor emits valid structured data with its declared nonzero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-cli-doctor-"));
    const home = join(root, "home");
    const codexRoot = join(root, "codex");
    const source = join(root, "source");
    await copySkitFixture("authored", source);
    expect(
      spawnSync(process.execPath, [bin, "add", source, "--home", home], { encoding: "utf8" })
        .status,
    ).toBe(0);
    expect(
      spawnSync(
        process.execPath,
        [bin, "enable", "review", "--for", "codex", "--home", home, "--codex-root", codexRoot],
        { encoding: "utf8" },
      ).status,
    ).toBe(0);
    await rm(join(codexRoot, "review"), { recursive: true });
    const result = spawnSync(
      process.execPath,
      [bin, "doctor", "--home", home, "--codex-root", codexRoot, "--json"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(12);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        schema: "skit.doctor.v2",
        data: expect.objectContaining({ ok: false, issues: expect.any(Array) }),
      }),
    );
  });

  test("invalid options use the usage exit and stderr", () => {
    const result = spawnSync(process.execPath, [bin, "list", "--wat", "--json"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(64);
    expect(JSON.parse(result.stderr).error.code).toBe("INVALID_ARGUMENT");
    expect(result.stdout).toBe("");

    const bareDisable = spawnSync(process.execPath, [bin, "disable", "--json"], {
      encoding: "utf8",
    });
    expect(bareDisable.status).toBe(64);
    expect(JSON.parse(bareDisable.stderr).error.code).toBe("INVALID_ARGUMENT");

    const bareEnable = spawnSync(process.execPath, [bin, "enable", "--json"], {
      encoding: "utf8",
    });
    expect(bareEnable.status).toBe(64);
    expect(JSON.parse(bareEnable.stderr).error.code).toBe("INVALID_ARGUMENT");
  });

  test("add emits a structured machine-readable result", async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-terminal-e2e-"));
    const source = join(root, "source");
    const jsonHome = join(root, "json-home");
    await copySkitFixture("authored", source);

    const machine = spawnSync(
      process.execPath,
      [bin, "add", source, "--home", jsonHome, "--json"],
      { encoding: "utf8" },
    );
    expect(machine.status).toBe(0);
    expect(machine.stderr).toBe("");
    expect(JSON.parse(machine.stdout)).toEqual(
      expect.objectContaining({
        schema: "skit.add.v3",
        data: expect.objectContaining({
          collection_id: expect.any(String),
          skills: [expect.objectContaining({ name: "review" })],
        }),
      }),
    );
  });

  test("add rejects invalid SKITs with the validation exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-invalid-e2e-"));
    await writeFile(join(root, "README.md"), "not a SKIT\n");
    const home = await mkdtemp(join(tmpdir(), "skit-invalid-add-home-"));
    const added = spawnSync(process.execPath, [bin, "add", root, "--json", "--home", home], {
      encoding: "utf8",
    });
    expect(added.status).toBe(65);
    expect(JSON.parse(added.stderr).error.code).toBe("VALIDATION_FAILED");
    expect(added.stdout).toBe("");
  });

  test("invalid descriptor identities use the argument exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-duplicate-e2e-"));
    const home = await mkdtemp(join(tmpdir(), "skit-duplicate-home-"));
    await copySkitFixture("duplicate-skills", root);
    const result = spawnSync(process.execPath, [bin, "add", root, "--json", "--home", home], {
      encoding: "utf8",
    });
    expect(result.status).toBe(64);
    expect(JSON.parse(result.stderr).error.code).toBe("INVALID_ARGUMENT");
  });

  test("repository enable dry-run returns a plan without changing bindings or disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-cli-e2e-"));
    const home = join(root, "home"),
      source = join(root, "source"),
      repo = join(root, "repo");
    await copySkitFixture("authored", source);
    const preview = spawnSync(
      process.execPath,
      [bin, "add", source, "--list", "--json", "--home", home],
      { encoding: "utf8" },
    );
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).schema).toBe("skit.add.preview.v3");
    expect(existsSync(join(home, "state.json"))).toBe(false);
    expect(
      spawnSync(process.execPath, [bin, "add", source, "--home", home], { encoding: "utf8" })
        .status,
    ).toBe(0);
    const result = spawnSync(
      process.execPath,
      [
        bin,
        "enable",
        "review",
        "--for",
        "codex",
        "--repo",
        repo,
        "--dry-run",
        "--json",
        "--home",
        home,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).schema).toBe("skit.enable.plan.v2");
    expect(existsSync(join(repo, ".agents", "skills", "review"))).toBe(false);
    const state = Schema.decodeUnknownSync(StateBindingsDocument)(
      await readFile(join(home, "state.json"), "utf8"),
    );
    expect(state.global_bindings).toEqual([]);
  });

  test("all harnesses and lifecycle dry-runs preserve exact state and projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-cli-matrix-"));
    const home = join(root, "home");
    const configHome = join(root, "config");
    const source = join(root, "source");
    const repo = join(root, "repo");
    await mkdir(join(configHome, "devin"), { recursive: true });
    await copySkitFixture("authored", source);
    const skill = join(source, "skills", "review", "SKILL.md");
    await writeFile(skill, "---\nname: review\ndescription: Review code.\n---\n# v1\n");
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          bin,
          ...args,
          "--home",
          home,
          "--codex-root",
          join(root, "detected-codex"),
          "--claude-root",
          join(root, "detected-claude"),
          "--opencode-root",
          join(root, "detected-opencode"),
          "--devin-root",
          join(root, "detected-devin"),
        ],
        { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: configHome } },
      );
    expect(run("add", source).status).toBe(0);
    expect(run("enable", "review", "--repo", repo).status).toBe(0);
    for (const relative of [
      ".agents/skills/review/SKILL.md",
      ".claude/skills/review/SKILL.md",
      ".opencode/skills/review/SKILL.md",
      ".devin/skills/review/SKILL.md",
    ])
      expect(readFileSync(join(repo, relative), "utf8")).toContain("# v1");

    const stateBefore = readFileSync(join(home, "state.json"));
    const codexBefore = readFileSync(join(repo, ".agents", "skills", "review", "SKILL.md"));
    await writeFile(skill, "---\nname: review\ndescription: Review code.\n---\n# v2\n");
    for (const args of [
      ["disable", "review", "--for", "codex", "--repo", repo, "--dry-run", "--json"],
      ["update", "review", "--dry-run", "--json"],
      ["remove", "review", "--dry-run", "--json"],
    ])
      expect(run(...args).status).toBe(0);
    expect(readFileSync(join(home, "state.json"))).toEqual(stateBefore);
    expect(readFileSync(join(repo, ".agents", "skills", "review", "SKILL.md"))).toEqual(
      codexBefore,
    );

    expect(run("disable", "review", "--for", "codex", "--repo", repo).status).toBe(0);
    expect(existsSync(join(repo, ".agents", "skills", "review"))).toBe(false);
  });

  test("projection drift exits with conflict status through the executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-cli-conflict-"));
    const home = join(root, "home"),
      source = join(root, "source"),
      repo = join(root, "repo");
    await copySkitFixture("authored", source);
    const args = (values: string[]) =>
      spawnSync(process.execPath, [bin, ...values, "--home", home], { encoding: "utf8" });
    expect(args(["add", source]).status).toBe(0);
    expect(args(["enable", "review", "--for", "codex", "--repo", repo]).status).toBe(0);
    await writeFile(join(repo, ".agents", "skills", "review", "SKILL.md"), "changed externally\n");
    const result = args(["disable", "review", "--for", "codex", "--repo", repo, "--json"]);
    expect(result.status).toBe(12);
    expect(JSON.parse(result.stderr).error.code).toBe("CONFLICT");
    expect(result.stdout).toBe("");
  });

  test("retains selected Projection bytes through the built CLI without overwriting disagreement", async () => {
    const root = await mkdtemp(join(tmpdir(), "skit-cli-projection-retention-"));
    const home = join(root, "home");
    const source = join(root, "source");
    const codexRoot = join(root, "codex");
    const claudeRoot = join(root, "claude");
    const opencodeRoot = join(root, "opencode");
    let configuredCodexRoot = codexRoot;
    let configuredClaudeRoot = claudeRoot;
    let configuredOpencodeRoot = opencodeRoot;
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\noriginal\n",
    );
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          bin,
          ...args,
          "--home",
          home,
          "--codex-root",
          configuredCodexRoot,
          "--claude-root",
          configuredClaudeRoot,
          "--opencode-root",
          configuredOpencodeRoot,
          "--json",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );
    expect(run("add", source).status).toBe(0);
    for (const harness of ["codex", "claude-code", "opencode"])
      expect(run("enable", "review", "--for", harness).status).toBe(0);

    const paths = {
      codex: join(codexRoot, "review"),
      "claude-code": join(claudeRoot, "review"),
      opencode: join(opencodeRoot, "review"),
    };
    configuredCodexRoot = join(root, "new-codex-root");
    configuredClaudeRoot = join(root, "new-claude-root");
    configuredOpencodeRoot = join(root, "new-opencode-root");
    const markerBefore = {
      codex: await readFile(join(paths.codex, ".skit-ownership.json"), "utf8"),
      "claude-code": await readFile(join(paths["claude-code"], ".skit-ownership.json"), "utf8"),
      opencode: await readFile(join(paths.opencode, ".skit-ownership.json"), "utf8"),
    };
    const selectedBytes = "---\nname: review\ndescription: Review code.\n---\nselected change\n";
    const differentBytes = "---\nname: review\ndescription: Review code.\n---\ndifferent change\n";
    await writeFile(join(paths.codex, "SKILL.md"), selectedBytes);
    await writeFile(join(paths["claude-code"], "SKILL.md"), selectedBytes);
    await writeFile(join(paths.opencode, "SKILL.md"), differentBytes);

    const stateBeforePreview = await readFile(join(home, "state.json"), "utf8");
    const previewProcess = run("update", "review", "--from-projection", "claude-code", "--dry-run");
    expect(previewProcess.status).toBe(0);
    const preview = Schema.decodeUnknownSync(ProjectionRetentionPlanDocument)(
      previewProcess.stdout,
    );
    expect(preview.data.projections.map(({ harness, agreement }) => [harness, agreement])).toEqual([
      ["codex", "identical"],
      ["claude-code", "selected"],
      ["opencode", "different"],
    ]);
    expect(preview.data.observed_digest).not.toBe("");
    expect(preview.data.snapshot_digest).not.toBe("");
    expect(existsSync(preview.data.retained_path)).toBe(false);
    expect(await readFile(join(home, "state.json"), "utf8")).toBe(stateBeforePreview);
    expect(await readFile(join(paths.opencode, ".skit-ownership.json"), "utf8")).toBe(
      markerBefore.opencode,
    );

    const applyProcess = run("update", "review", "--from-projection", "claude-code");
    expect(applyProcess.status).toBe(0);
    const applied = Schema.decodeUnknownSync(ProjectionRetentionResultDocument)(
      applyProcess.stdout,
    );
    expect(applied.data.previous_skill_version_id).toBe(preview.data.previous_skill_version_id);
    expect(applied.data.retained_skill_version_id).not.toBe(applied.data.previous_skill_version_id);
    expect(applied.data.retained).toBe(true);
    expect(applied.data.projections.map(({ harness, status }) => [harness, status])).toEqual([
      ["codex", "projected"],
      ["claude-code", "projected"],
      ["opencode", "conflicted"],
    ]);

    const state = Schema.decodeUnknownSync(ProjectionRetentionStateDocument)(
      await readFile(join(home, "state.json"), "utf8"),
    );
    const retainedSkill = state.skills.find((skill) => skill.skill_id === preview.data.skill_id);
    expect(retainedSkill?.versions).toHaveLength(2);
    expect(retainedSkill?.selected_skill_version_id).toBe(applied.data.retained_skill_version_id);
    expect(state.acquisitions.at(-1)).toMatchObject({
      source_identity: {
        kind: "local",
        path: { value: paths["claude-code"] },
      },
      input: { value: paths["claude-code"] },
    });
    expect(await readFile(join(preview.data.retained_path, "SKILL.md"), "utf8")).toBe(
      selectedBytes,
    );
    expect(await readFile(join(paths.codex, "SKILL.md"), "utf8")).toBe(selectedBytes);
    expect(await readFile(join(paths["claude-code"], "SKILL.md"), "utf8")).toBe(selectedBytes);
    expect(await readFile(join(paths.opencode, "SKILL.md"), "utf8")).toBe(differentBytes);
    expect(await readFile(join(paths.codex, ".skit-ownership.json"), "utf8")).not.toBe(
      markerBefore.codex,
    );
    expect(await readFile(join(paths["claude-code"], ".skit-ownership.json"), "utf8")).not.toBe(
      markerBefore["claude-code"],
    );
    expect(await readFile(join(paths.opencode, ".skit-ownership.json"), "utf8")).toBe(
      markerBefore.opencode,
    );
    expect(existsSync(join(configuredCodexRoot, "review"))).toBe(false);
    expect(existsSync(join(configuredClaudeRoot, "review"))).toBe(false);
    expect(existsSync(join(configuredOpencodeRoot, "review"))).toBe(false);

    const doctorProcess = run("doctor");
    expect(doctorProcess.status).toBe(12);
    const doctor = Schema.decodeUnknownSync(DoctorDocument)(doctorProcess.stdout);
    expect(doctor.data.issues).toEqual([
      expect.objectContaining({ code: "PROJECTION_CONFLICT", path: paths.opencode }),
    ]);

    const partialState = JSON.parse(await readFile(join(home, "state.json"), "utf8"));
    const selectedDigest = preview.data.observed_digest;
    for (const harness of ["codex", "claude-code"] as const) {
      const marker = JSON.parse(markerBefore[harness]);
      await writeFile(join(paths[harness], ".skit-ownership.json"), markerBefore[harness]);
      const projection = partialState.projections.find(
        (candidate: { harness: string; path: string }) =>
          candidate.harness === harness && candidate.path === paths[harness],
      );
      projection.skill_version_id = marker.skill_version_id;
      projection.expected_digest = marker.expected_digest;
      projection.observed_digest = selectedDigest;
      projection.status = "conflicted";
    }
    await writeFile(join(home, "state.json"), `${JSON.stringify(partialState, null, 2)}\n`);
    const beforeRecovery = Schema.decodeUnknownSync(ProjectionRetentionStateDocument)(
      await readFile(join(home, "state.json"), "utf8"),
    );
    const recoveredProcess = run("update", "review", "--from-projection", "claude-code");
    expect(recoveredProcess.status).toBe(0);
    const recovered = Schema.decodeUnknownSync(ProjectionRetentionResultDocument)(
      recoveredProcess.stdout,
    );
    expect(recovered.data.retained).toBe(false);
    expect(recovered.data.retained_skill_version_id).toBe(applied.data.retained_skill_version_id);
    expect(recovered.data.projections.map(({ harness, status }) => [harness, status])).toEqual([
      ["codex", "projected"],
      ["claude-code", "projected"],
      ["opencode", "conflicted"],
    ]);
    const afterRecovery = Schema.decodeUnknownSync(ProjectionRetentionStateDocument)(
      await readFile(join(home, "state.json"), "utf8"),
    );
    expect(afterRecovery.skills[0]?.versions.length).toBe(
      beforeRecovery.skills[0]?.versions.length,
    );
    expect(afterRecovery.acquisitions.length).toBe(beforeRecovery.acquisitions.length);

    const stateBeforeRepeat = await readFile(join(home, "state.json"), "utf8");
    const repeated = run("update", "review", "--from-projection", "claude-code");
    expect(repeated.status).toBe(11);
    expect(await readFile(join(home, "state.json"), "utf8")).toBe(stateBeforeRepeat);
  });
});
