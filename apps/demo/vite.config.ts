import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  build: {
    // Monaco is large; the demo is a dev harness, not a shipped bundle.
    chunkSizeWarningLimit: 4096,
  },
});
