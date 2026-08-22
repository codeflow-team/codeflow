import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    // Monaco is large; the demo is a dev harness, not a shipped bundle.
    chunkSizeWarningLimit: 4096,
  },
});
