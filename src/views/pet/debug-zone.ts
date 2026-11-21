/**
 * dev 调试框几何（模型无关）：由模型声明的 visualBounds + 当前帧 root
 * 变换推导精灵在屏幕坐标系（CSS 像素）下的紧贴 AABB。
 *
 * 变换次序与 CanvasPetRenderer.drawFrame 的 canvas 状态机严格一致
 * （translate → rotate → scale 后绘制局部坐标），因此框在任何模型、
 * 任何动作帧（跳跃/挤压/镜像翻转）下都紧贴精灵本体。
 * 纯函数无副作用，方便对翻转/旋转/位移各情形做单元验证。
 */

export type DebugRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type DebugRootTransform = {
	x: number;
	y: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
	facingX: number;
};

export type DebugBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export function spriteScreenRect(
	bounds: DebugBounds,
	root: DebugRootTransform,
	origin: { x: number; y: number },
): DebugRect {
	const scaleX = root.scaleX * root.facingX;
	const scaleY = root.scaleY;
	const cos = Math.cos(root.rotation);
	const sin = Math.sin(root.rotation);
	const corners: Array<[number, number]> = [
		[bounds.x, bounds.y],
		[bounds.x + bounds.width, bounds.y],
		[bounds.x + bounds.width, bounds.y + bounds.height],
		[bounds.x, bounds.y + bounds.height],
	];
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [cx, cy] of corners) {
		const localX = cx * scaleX;
		const localY = cy * scaleY;
		const rotatedX = localX * cos - localY * sin;
		const rotatedY = localX * sin + localY * cos;
		const px = origin.x + root.x + rotatedX;
		const py = origin.y + root.y + rotatedY;
		if (px < minX) minX = px;
		if (py < minY) minY = py;
		if (px > maxX) maxX = px;
		if (py > maxY) maxY = py;
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
