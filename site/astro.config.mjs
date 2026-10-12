// @ts-check
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory" },
  vite: {
    // data/ and team.json live at the repo root, one level above the Astro root.
    // The /api proxy is dev-only convenience — in production nginx on arachnea
    // proxies ^~ /api/ to lvlnb-api, so the browser always sees one origin.
    server: {
      fs: { allow: [repoRoot] },
      proxy: { "/api": { target: "http://127.0.0.1:8112", changeOrigin: true } },
    },
  },
});
