export type ScreenPoint = Readonly<{ x: number; y: number }>;

export type ScreenRectangle = Readonly<{
	x: number;
	y: number;
	width: number;
	height: number;
}>;

export type PetWindowFrame = ScreenRectangle;

/**
 * A rectangle in window-local coordinates that represents the rendered pet
 * rather than the complete transparent WebView.
 */
export type PetWindowVisibleBounds = ScreenRectangle;

export type PetDisplay = Readonly<{
	id: number;
	workArea: ScreenRectangle;
	isPrimary: boolean;
}>;

export interface PetWindowHandle {
	getFrame(): PetWindowFrame;
	setPosition(x: number, y: number): unknown;
	showInactive(): unknown;
	hide(): unknown;
}

export interface PetScreenHandle {
	getCursorScreenPoint(): ScreenPoint;
	getMouseButtons(): bigint;
	getAllDisplays(): readonly PetDisplay[];
	getPrimaryDisplay(): PetDisplay;
}

export type NativeDragEndReason = "pointerup" | "webview" | "hidden" | "disposed";

export interface NativeDragEvent {
	dragging: boolean;
	reason?: NativeDragEndReason;
	position: ScreenPoint;
}

export interface PetWindowControllerOptions {
	pollIntervalMs?: number;
	/** Keep this visible part of the pet on screen, not the full transparent window. */
	visibleBounds?: PetWindowVisibleBounds;
	/** Small visible-pixel margin that avoids clipping outlines and animation bleed. */
	edgeGap?: number;
	/** Applies an additional caller-owned constraint after pet-body clamping. */
	constrainPosition?: (position: ScreenPoint, workArea: ScreenRectangle) => ScreenPoint;
	/** Receives every native position update while the pet is being dragged. */
	onPositionChange?: (position: ScreenPoint) => void;
	onDragStateChange?: (event: NativeDragEvent) => void;
}

type DragSession = {
	offset: ScreenPoint;
	timer: ReturnType<typeof setInterval>;
};

const LEFT_MOUSE_BUTTON = 1n;

function containsPoint(rectangle: ScreenRectangle, point: ScreenPoint): boolean {
	return (
		point.x >= rectangle.x &&
		point.y >= rectangle.y &&
		point.x < rectangle.x + rectangle.width &&
		point.y < rectangle.y + rectangle.height
	);
}

function pointDistanceSquared(rectangle: ScreenRectangle, point: ScreenPoint): number {
	const nearestX = Math.max(rectangle.x, Math.min(point.x, rectangle.x + rectangle.width));
	const nearestY = Math.max(rectangle.y, Math.min(point.y, rectangle.y + rectangle.height));
	const deltaX = point.x - nearestX;
	const deltaY = point.y - nearestY;
	return deltaX * deltaX + deltaY * deltaY;
}

export function displayForPoint(
	displays: readonly PetDisplay[],
	point: ScreenPoint,
	fallback: PetDisplay,
): PetDisplay {
	const containing = displays.find((display) => containsPoint(display.workArea, point));
	if (containing) return containing;
	if (displays.length === 0) return fallback;
	return displays.reduce((nearest, display) =>
		pointDistanceSquared(display.workArea, point) <
		pointDistanceSquared(nearest.workArea, point)
			? display
			: nearest,
	);
}

export function clampWindowPosition(
	desired: ScreenPoint,
	windowSize: Readonly<{ width: number; height: number }>,
	workArea: ScreenRectangle,
): ScreenPoint {
	return clampWindowPositionToVisibleBounds(
		desired,
		{ x: 0, y: 0, width: windowSize.width, height: windowSize.height },
		workArea,
	);
}

/**
 * Clamps a transparent pet window by its rendered body. This lets intentional
 * WebView whitespace, speech bubbles, and effects extend outside the display
 * while keeping the pet reachable at every edge.
 */
export function clampWindowPositionToVisibleBounds(
	desired: ScreenPoint,
	visibleBounds: PetWindowVisibleBounds,
	workArea: ScreenRectangle,
	edgeGap = 0,
): ScreenPoint {
	const gap = Math.max(0, Math.round(edgeGap));
	const minimumX = workArea.x + gap - visibleBounds.x;
	const minimumY = workArea.y + gap - visibleBounds.y;
	const maximumX = Math.max(
		minimumX,
		workArea.x + workArea.width - gap - visibleBounds.x - visibleBounds.width,
	);
	const maximumY = Math.max(
		minimumY,
		workArea.y + workArea.height - gap - visibleBounds.y - visibleBounds.height,
	);
	return {
		x: Math.round(Math.max(minimumX, Math.min(desired.x, maximumX))),
		y: Math.round(Math.max(minimumY, Math.min(desired.y, maximumY))),
	};
}

/** Places a companion card directly below the visible pet. */
export function positionWindowBelowPet(
	petFrame: PetWindowFrame,
	petVisibleBounds: PetWindowVisibleBounds,
	overlap = 28,
): ScreenPoint {
	const safeOverlap = Math.max(0, Math.round(overlap));
	return {
		x: Math.round(petFrame.x),
		y: Math.round(petFrame.y + petVisibleBounds.y + petVisibleBounds.height - safeOverlap),
	};
}

/**
 * Moves the pet just enough to keep an attached below-card fully on screen.
 * The caller should first apply the normal visible-pet constraint, so this
 * only adds the space needed by the companion card.
 */
export function clampPetPositionForBelowWindow(
	desired: ScreenPoint,
	petVisibleBounds: PetWindowVisibleBounds,
	windowSize: Readonly<{ width: number; height: number }>,
	workArea: ScreenRectangle,
	overlap = 28,
): ScreenPoint {
	const safeOverlap = Math.max(0, Math.round(overlap));
	const attachmentY = petVisibleBounds.y + petVisibleBounds.height - safeOverlap;
	const minX = workArea.x;
	const maxX = Math.max(minX, workArea.x + workArea.width - windowSize.width);
	const minY = workArea.y - attachmentY;
	const maxY = Math.max(minY, workArea.y + workArea.height - windowSize.height - attachmentY);
	return {
		x: Math.round(Math.max(minX, Math.min(desired.x, maxX))),
		y: Math.round(Math.max(minY, Math.min(desired.y, maxY))),
	};
}

/**
 * Owns native-window movement while the WebView only reports drag start/end.
 * System cursor polling keeps the grabbed point stable even when moving the
 * transparent WebView would otherwise interrupt pointer events.
 */
export class PetWindowController {
	private dragSession: DragSession | null = null;
	private visible = true;
	private readonly pollIntervalMs: number;
	private readonly visibleBounds?: PetWindowVisibleBounds;
	private readonly edgeGap: number;
	private readonly constrainPosition?: (position: ScreenPoint, workArea: ScreenRectangle) => ScreenPoint;
	private readonly onPositionChange?: (position: ScreenPoint) => void;
	private readonly onDragStateChange?: (event: NativeDragEvent) => void;

	constructor(
		private readonly window: PetWindowHandle,
		private readonly screen: PetScreenHandle,
		options: PetWindowControllerOptions = {},
	) {
		this.pollIntervalMs = Math.max(16, options.pollIntervalMs ?? 24);
		this.visibleBounds = options.visibleBounds;
		this.edgeGap = Math.max(0, options.edgeGap ?? 0);
		this.constrainPosition = options.constrainPosition;
		this.onPositionChange = options.onPositionChange;
		this.onDragStateChange = options.onDragStateChange;
	}

	get isDragging(): boolean {
		return this.dragSession !== null;
	}

	beginDrag(initialDragDelta: ScreenPoint = { x: 0, y: 0 }): void {
		if (!this.visible || this.dragSession) return;
		const cursor = this.screen.getCursorScreenPoint();
		const frame = this.window.getFrame();
		const timer = setInterval(() => this.updateDrag(), this.pollIntervalMs);
		this.dragSession = {
			// The WebView reports dragStart after its movement threshold. Subtracting
			// that initial delta preserves the exact point originally grabbed.
			offset: {
				x: cursor.x - frame.x - initialDragDelta.x,
				y: cursor.y - frame.y - initialDragDelta.y,
			},
			timer,
		};
		this.onDragStateChange?.({
			dragging: true,
			position: { x: frame.x, y: frame.y },
		});
	}

	endDrag(reason: NativeDragEndReason = "webview"): void {
		const session = this.dragSession;
		if (!session) return;
		clearInterval(session.timer);
		this.dragSession = null;
		const frame = this.window.getFrame();
		this.onDragStateChange?.({
			dragging: false,
			reason,
			position: { x: frame.x, y: frame.y },
		});
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) {
			this.window.showInactive();
			return;
		}
		this.endDrag("hidden");
		this.window.hide();
	}

	dispose(): void {
		this.endDrag("disposed");
	}

	/** Exposed for deterministic tests; production calls this from the timer. */
	updateDrag(): void {
		const session = this.dragSession;
		if (!session) return;
		if ((this.screen.getMouseButtons() & LEFT_MOUSE_BUTTON) === 0n) {
			this.endDrag("pointerup");
			return;
		}

		const cursor = this.screen.getCursorScreenPoint();
		const frame = this.window.getFrame();
		const displays = this.screen.getAllDisplays();
		const display = displayForPoint(displays, cursor, this.screen.getPrimaryDisplay());
		const visibleBounds = this.visibleBounds ?? {
			x: 0,
			y: 0,
			width: frame.width,
			height: frame.height,
		};
		const clampedPosition = clampWindowPositionToVisibleBounds(
			{ x: cursor.x - session.offset.x, y: cursor.y - session.offset.y },
			visibleBounds,
			display.workArea,
			this.edgeGap,
		);
		const position = this.constrainPosition?.(clampedPosition, display.workArea) ?? clampedPosition;
		this.window.setPosition(position.x, position.y);
		this.onPositionChange?.(position);
	}
}
