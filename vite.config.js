import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend lives in /client, builds to /dist, and is served by server.js.
// In dev mode (npm run dev) API calls are forwarded to the Express server on port 3000.
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
