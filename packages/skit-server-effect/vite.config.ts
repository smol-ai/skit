import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const exampleWranglerConfigPath = fileURLToPath(
  new URL("./wrangler.example.jsonc", import.meta.url),
);
const wranglerConfigPath =
  process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH ?? exampleWranglerConfigPath;

export default defineConfig(({ command }) => {
  const buildId = process.env.FOLDKIT_BUILD_ID;
  if (command === "build" && buildId === undefined)
    throw new Error("FOLDKIT_BUILD_ID is required; run the package build script");
  return {
    root: fileURLToPath(new URL("./web", import.meta.url)),
    plugins: [
      tailwindcss(),
      foldkit(buildId === undefined ? {} : { buildId }),
      cloudflare({
        configPath: wranglerConfigPath,
        persistState: {
          path: fileURLToPath(new URL("./.wrangler/state", import.meta.url)),
        },
      }),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) },
      dedupe: ["effect", "@effect/platform-browser"],
    },
  };
});
