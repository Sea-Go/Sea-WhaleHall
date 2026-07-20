import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const viewsRoot = resolve(projectRoot, "src/views");

export default defineConfig({
	root: viewsRoot,
	base: "./",
	plugins: [react()],
	build: {
		outDir: resolve(projectRoot, "dist/views"),
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			input: {
				client: resolve(viewsRoot, "client/index.html"),
				pet: resolve(viewsRoot, "pet/index.html"),
			},
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
	},
});
