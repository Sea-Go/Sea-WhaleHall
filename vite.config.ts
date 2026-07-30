import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const viewsRoot = resolve(projectRoot, "src/views");

export default defineConfig(({ command }) => {
	const developmentConnectSources =
		command === "serve"
			? "http://127.0.0.1:5173 ws://127.0.0.1:5173"
			: "";
	return {
		root: viewsRoot,
		base: "./",
		plugins: [
			react(),
			{
				name: "whalehall-csp-environment",
				transformIndexHtml(html) {
					return html.replaceAll(
						"__WHALEHALL_DEV_CONNECT__",
						developmentConnectSources,
					);
				},
			},
		],
		build: {
			outDir: resolve(projectRoot, "dist/views"),
			emptyOutDir: true,
			sourcemap: true,
			rollupOptions: {
				input: {
					client: resolve(viewsRoot, "client/index.html"),
					pet: resolve(viewsRoot, "pet/index.html"),
					"pet-demo": resolve(viewsRoot, "pet/demo.html"),
				},
			},
		},
		server: {
			host: "127.0.0.1",
			port: 5173,
			strictPort: true,
		},
	};
});
