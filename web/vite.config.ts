import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The built bundle is embedded into the Rust binary (rust-embed) and served
// under `/`, so assets use relative paths and no publicPath. Only hashed
// static assets are cached; index.html is served no-store by the Rust adapter.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
