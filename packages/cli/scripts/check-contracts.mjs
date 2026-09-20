import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { commandContractArtifacts } from "../dist/src/commands/artifacts.js";
import { checkContractCompatibility } from "../dist/src/commands/contract-compatibility.js";
import { commandApplicationLayer } from "../dist/src/application.js";

const root = resolve(import.meta.dirname, "../../..");
const contractsPath = "packages/cli/contracts";
const argument = process.argv.indexOf("--base");
const explicitBase = argument === -1 ? undefined : process.argv[argument + 1];

const git = (args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const base = explicitBase ?? git(["merge-base", "HEAD", "origin/main"]);
const paths = git(["ls-tree", "-r", "--name-only", base, "--", contractsPath])
  .split("\n")
  .filter((path) => path.endsWith(".json"));
const baseArtifacts = Object.fromEntries(
  paths
    .filter((path) => !path.endsWith("/command-manifest.json"))
    .map((path) => [path.slice(contractsPath.length + 1), git(["show", `${base}:${path}`]) + "\n"]),
);
const baseManifest = git(["show", `${base}:${contractsPath}/command-manifest.json`]);
const headArtifacts = await Effect.runPromise(
  commandContractArtifacts().pipe(
    Effect.provide(commandApplicationLayer(false, join(root, ".tmp", "contract-check-home"))),
    Effect.provide(NodeServices.layer),
  ),
);
const result = checkContractCompatibility({ baseArtifacts, headArtifacts, baseManifest });

for (const warning of result.warnings) console.warn(`warning: ${warning}`);
for (const error of result.errors) console.error(`error: ${error}`);
if (result.errors.length > 0) process.exitCode = 1;
