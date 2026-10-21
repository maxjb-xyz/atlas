import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, the Worker runs on wrangler's port; the app proxies to it.
const worker = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: worker, changeOrigin: false },
      "/agents": { target: worker, changeOrigin: false, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
