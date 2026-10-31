import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env.SORVEX_DESKTOP_PORT ?? "4517";

// Tauri loads the dev server from a fixed port, so a taken port must fail instead of moving.
// /api goes to the Node server (apps/desktop/server), including the /api/events stream.
export default defineConfig({
	plugins: [react()],
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		watch: { ignored: ["**/src-tauri/**", "**/server/**", "**/extension/**"] },
		proxy: { "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false } },
	},
	build: {
		target: "es2022",
		outDir: "dist",
		// One local bundle for a desktop webview; highlight.js grammars push it past the web-oriented default.
		chunkSizeWarningLimit: 2000,
	},
});
