import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // ローカル開発：npx wrangler dev（:8787）と併用すると /api がつながる
  server: { proxy: { "/api": "http://localhost:8787" } },
  test: { environment: "jsdom" },
} as never);
