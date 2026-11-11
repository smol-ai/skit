import { join, resolve } from "node:path";
import { Effect } from "effect";
import { commandContractArtifacts } from "../dist/src/commands/artifacts.js";
import { checkContractCompatibility } from "../dist/src/commands/contract-compatibility.js";
import { cliLayer } from "../dist/src/application.js";
import { readPublishedContracts } from "./published-contracts.mjs";

const root = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--release"))
  throw new Error(
    "Usage: check-contracts.mjs [--release <published-version>]; Git branch baselines are not supported",
  );
const published = await readPublishedContracts(args[1]);
console.log(
  `Checking against published @smolai/skit@${published.version} (${published.integrity})`,
);
const headArtifacts = await Effect.runPromise(
  commandContractArtifacts().pipe(
    Effect.provide(cliLayer(false, join(root, ".tmp", "contract-check-home"))),
    Effect.scoped,
  ),
);
const result = checkContractCompatibility({
  baseArtifacts: published.artifacts,
  headArtifacts,
  baseManifest: published.artifacts["command-manifest.json"],
});

for (const warning of result.warnings) console.warn(`warning: ${warning}`);
for (const error of result.errors) console.error(`error: ${error}`);
if (result.errors.length > 0) process.exitCode = 1;
else console.log("Released contract compatibility passed");
