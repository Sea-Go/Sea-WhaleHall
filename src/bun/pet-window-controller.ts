export type ScreenPoint = Readonly<{ x: number; y: number }>;

export type ScreenRectangle = Readonly<{
	x: number;
	y: number;
	width: number;
	height: number;
}>;

export type PetWindowFrame = ScreenRectangle;

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
	const maximumX = workArea.x + Math.max(0, workArea.width - windowSize.width);
	const maximumY = workArea.y + Math.max(0, workArea.height - windowSize.height);
	return {
		x: Math.round(Math.max(workArea.x, Math.min(desired.x, maximumX))),
		y: Math.round(Math.max(workArea.y, Math.min(desired.y, maximumY))),
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
	private readonly onDragStateChange?: (event: NativeDragEvent) => void;

	constructor(
		private readonly window: PetWindowHandle,
		private readonly screen: PetScreenHandle,
		options: PetWindowControllerOptions = {},
	) {
		this.pollIntervalMs = Math.max(16, options.pollIntervalMs ?? 24);
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
		const position = clampWindowPosition(
			{ x: cursor.x - session.offset.x, y: cursor.y - session.offset.y },
			frame,
			display.workArea,
		);
		this.window.setPosition(position.x, position.y);
	}
}
