/**
 * 渲染适配器注册表:按 pet.json.renderer 分派。
 * 新增渲染器(live2d 等)=在此注册一行。
 */

import type { PetRendererAdapter, ResolvedPetPack } from "./types";
import { SequenceRendererAdapter } from "./sequence-adapter";

export type PetRendererFactory = (pack: ResolvedPetPack) => PetRendererAdapter;

const FACTORIES = new Map<string, PetRendererFactory>([
	["sequence", (pack) => new SequenceRendererAdapter(pack)],
	// live2d:二期接入(pixi-live2d-display)。
]);

export function createRendererAdapter(pack: ResolvedPetPack): PetRendererAdapter {
	const factory = FACTORIES.get(pack.manifest.renderer);
	if (factory === undefined) {
		throw new Error(`未注册的渲染器类型: ${pack.manifest.renderer}`);
	}
	return factory(pack);
}

export function registerRendererFactory(kind: string, factory: PetRendererFactory): void {
	FACTORIES.set(kind, factory);
}
