import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const buildEnvironment = (environment = process.env, createBuildId = randomUUID) => ({
  ...environment,
  FOLDKIT_BUILD_ID: environment.FOLDKIT_BUILD_ID ?? createBuildId(),
});

export const main = () => {
  const result = spawnSync("vite", ["build"], {
    stdio: "inherit",
    env: buildEnvironment(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`vite build failed with exit code ${result.status}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
