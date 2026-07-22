export type Point = { x: number; y: number };

export interface PetTransform {
	x: number;
	y: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
}

export interface ClickMotion {
	active: boolean;
	progress: number;
	jump: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
}

export const CLICK_REACTION_DURATION_SECONDS = 0.72;

export const EMPTY_CLICK_MOTION: ClickMotion = {
	active: false,
	progress: 1,
	jump: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

/** Pure geometry used by the renderer and kept exported for interaction tests. */
export function isPointInsideWhale(
	localX: number,
	localY: number,
	padding = 0,
): boolean {
	const hitPadding = Math.max(0, padding);
	const bodyX = (localX - 4) / (112 + hitPadding);
	const bodyY = localY / (64 + hitPadding);
	const inBody = bodyX * bodyX + bodyY * bodyY <= 1;

	const upperTailX = (localX + 119) / (43 + hitPadding);
	const upperTailY = (localY + 24) / (34 + hitPadding);
	const inUpperTail = upperTailX * upperTailX + upperTailY * upperTailY <= 1;

	const lowerTailX = (localX + 119) / (43 + hitPadding);
	const lowerTailY = (localY - 25) / (34 + hitPadding);
	const inLowerTail = lowerTailX * lowerTailX + lowerTailY * lowerTailY <= 1;

	const finDeltaX = localX - 28;
	const finDeltaY = localY - 50;
	const finCosine = Math.cos(0.5);
	const finSine = Math.sin(0.5);
	const finX =
		(finDeltaX * finCosine + finDeltaY * finSine) / (38 + hitPadding);
	const finY =
		(-finDeltaX * finSine + finDeltaY * finCosine) / (14 + hitPadding);
	const inFin = finX * finX + finY * finY <= 1;

	return inBody || inUpperTail || inLowerTail || inFin;
}

/** Convert a canvas-space point into model-local coordinates. */
export function canvasPointToLocal(point: Point, transform: PetTransform): Point {
	const deltaX = point.x - transform.x;
	const deltaY = point.y - transform.y;
	const cosine = Math.cos(transform.rotation);
	const sine = Math.sin(transform.rotation);
	const safeScaleX = Math.abs(transform.scaleX) < 0.001 ? 0.001 : transform.scaleX;
	const safeScaleY = Math.abs(transform.scaleY) < 0.001 ? 0.001 : transform.scaleY;
	return {
		x: (deltaX * cosine + deltaY * sine) / safeScaleX,
		y: (-deltaX * sine + deltaY * cosine) / safeScaleY,
	};
}

/** Click pose: squash first, then spring upward and settle. */
export function getClickMotion(
	elapsedSeconds: number,
	reducedMotion = false,
): ClickMotion {
	if (elapsedSeconds < 0 || elapsedSeconds >= CLICK_REACTION_DURATION_SECONDS) {
		return EMPTY_CLICK_MOTION;
	}

	const progress = elapsedSeconds / CLICK_REACTION_DURATION_SECONDS;
	if (reducedMotion) {
		const pulse = Math.sin(progress * Math.PI);
		return {
			active: true,
			progress,
			jump: 0,
			rotation: 0,
			scaleX: 1 + pulse * 0.035,
			scaleY: 1 + pulse * 0.035,
		};
	}

	if (progress < 0.18) {
		const squash = Math.sin((progress / 0.18) * Math.PI);
		return {
			active: true,
			progress,
			jump: 0,
			rotation: 0,
			scaleX: 1 + squash * 0.13,
			scaleY: 1 - squash * 0.12,
		};
	}

	const leapProgress = (progress - 0.18) / 0.82;
	const leap = Math.sin(leapProgress * Math.PI);
	return {
		active: true,
		progress,
		jump: leap * 34,
		rotation: Math.sin(leapProgress * Math.PI * 2) * 0.045,
		scaleX: 1 - leap * 0.025,
		scaleY: 1 + leap * 0.075,
	};
}

export function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function damp(
	current: number,
	target: number,
	speed: number,
	deltaSeconds: number,
): number {
	return current + (target - current) * (1 - Math.exp(-speed * deltaSeconds));
}

export function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
