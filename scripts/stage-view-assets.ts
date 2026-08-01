import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function stageViewAssets(): void {
	const assets = resolve(projectRoot, "dist/views/assets");
	if (!existsSync(assets)) throw new Error(`Vite assets not found: ${assets}`);

	for (const view of ["client", "pet"]) {
		const destination = resolve(projectRoot, "dist/views", view, "assets");
		cpSync(assets, destination, { recursive: true, force: true });
		console.log(`[views] staged shared assets for ${view}`);
	}
}

if (import.meta.main) stageViewAssets();
