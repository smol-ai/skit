import { fileURLToPath } from "node:url";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The Atlas app serves existing atlas-data/ and copies it into static builds.
// `pnpm atlas:generate` explicitly refreshes that data. Relative URLs support any static path.
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "./",
  publicDir: fileURLToPath(new URL("./atlas-data", import.meta.url)),
  plugins: [tailwindcss(), foldkit()],
  build: {
    outDir: fileURLToPath(new URL("./atlas", import.meta.url)),
    emptyOutDir: true,
    // One bundle for a local tool: Effect, Foldkit and Fluid's icon set make it larger than a page.
    chunkSizeWarningLimit: 1024,
  },
  resolve: { dedupe: ["effect", "@effect/platform-browser"] },
});
