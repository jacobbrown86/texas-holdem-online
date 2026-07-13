import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Mobile-first game client. `server.host` lets you open the lobby on a phone
// on the same Wi-Fi during two-device testing.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
});
