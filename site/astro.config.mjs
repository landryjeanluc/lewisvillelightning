// @ts-check
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory" },
  vite: {
    // data/ and team.json live at the repo root, one level above the Astro root
    server: { fs: { allow: [repoRoot] } },
  },
});
