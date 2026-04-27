import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    // Runs the Worker (and Durable Object) locally during `vite dev`,
    // and emits a deployable Worker bundle during `vite build`.
    // Reads from wrangler.toml.
    cloudflare(),
  ],
});
