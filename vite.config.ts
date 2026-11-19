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
		// electrobun 2.x 的 npm 包只剩迁移 stub(moved.cjs),真正的 view API
		// 由 Hutch 投影在 .hutch/devkit。视图构建必须解析到 devkit,否则
		// Electroview 在模块初始化即 throw,客户端/桌宠的全部 RPC 静默死亡。
		resolve: {
			alias: {
				"electrobun/view": resolve(
					projectRoot,
					".hutch/devkit/api/browser/index.ts",
				),
			},
		},
		// 皮肤不再走 publicDir 静态直通：skins/ 现在包含皮肤源码（不该被
		// 原样打进视图产物）。序列帧由 decode-pet-skins.ts 解帧直写
		// dist/views/pet/deepseek/（见该脚本与 skins/README.md）。
		publicDir: false,
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
