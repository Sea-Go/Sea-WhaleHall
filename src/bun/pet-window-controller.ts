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
	/** 光标减「抓取点+按下后阈值位移」：窗口原点到光标的真实向量。 */
	grabOffset: ScreenPoint | null;
	/** getFrame 与真实坐标的偏差估计（拖拽开始时标定）。 */
	offsetEst: ScreenPoint | null;
	/** 上一帧下达的 setPosition 命令，用于检测坐标空间换挡。 */
	lastCommand: ScreenPoint | null;
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

/**
 * 拖拽钳制的垂直保留高度：鲸鱼画在 320×250 透明窗口的中段，若整窗都必须
 * 保留在 workArea 内，鲸鱼永远离屏幕上下边 ~100px。底部（无菜单栏）允许
 * 窗口溢出边缘、只保留该高度的可视带；顶部 macOS 会把浮动面板窗口钉在
 * 菜单栏下沿（实测 AX 直接设置也会被系统拉回 workArea.y），溢出无意义，
 * 因此顶部按 workArea.y 硬钳制。
 */
const MIN_VISIBLE_HEIGHT = 120;

export function clampWindowPosition(
	desired: ScreenPoint,
	windowSize: Readonly<{ width: number; height: number }>,
	workArea: ScreenRectangle,
	minVisibleHeight = windowSize.height,
): ScreenPoint {
	const maximumX = workArea.x + Math.max(0, workArea.width - windowSize.width);
	const keep = Math.min(windowSize.height, Math.max(1, minVisibleHeight));
	const maximumY = workArea.y + Math.max(0, workArea.height - keep);
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

	beginDrag(
		initialDragDelta: ScreenPoint = { x: 0, y: 0 },
		grabPoint?: ScreenPoint,
	): void {
		if (!this.visible || this.dragSession) return;
		const cursor = this.screen.getCursorScreenPoint();
		const frame = this.window.getFrame();
		const timer = setInterval(() => this.updateDrag(), this.pollIntervalMs);
		// 画布 CSS 像素与窗口 DIP 同尺度：光标减「按下点+按下后位移」即窗口真实原点，
		// getFrame 与它的差值即当前坐标空间的偏差，作为整场拖拽的基准。
		const grabOffset = grabPoint
			? {
					x: initialDragDelta.x + grabPoint.x,
					y: initialDragDelta.y + grabPoint.y,
				}
			: null;
		this.dragSession = {
			offset: {
				x: cursor.x - frame.x - initialDragDelta.x,
				y: cursor.y - frame.y - initialDragDelta.y,
			},
			grabOffset,
			offsetEst:
				grabOffset && !Number.isNaN(cursor.x - grabOffset.x)
					? {
							x: frame.x - (cursor.x - grabOffset.x),
							y: frame.y - (cursor.y - grabOffset.y),
						}
					: null,
			lastCommand: null,
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

	/**
	 * 坐标空间换挡检测阈值：单帧拖拽位移远小于该值；Electrobun 在多 DPI
	 * 布局下 getFrame/setPosition 的偏差按显示器切换（实测 458px 量级），
	 * 换挡表现为「读回帧相对上次命令的大跳变」。
	 */
	private static readonly FLIP_THRESHOLD = 300;

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
		if (session.grabOffset && session.offsetEst) {
			const lastCommand = session.lastCommand;
			if (lastCommand) {
				const flipX = frame.x - lastCommand.x;
				const flipY = frame.y - lastCommand.y;
				if (
					Math.abs(flipX) > PetWindowController.FLIP_THRESHOLD ||
					Math.abs(flipY) > PetWindowController.FLIP_THRESHOLD
				) {
					// 窗口实际没动，是坐标空间换挡：按读回差值重校准偏差估计，
					// 本帧命令立即用新偏差，跨屏不产生跳变。
					session.offsetEst = {
						x: session.offsetEst.x + flipX,
						y: session.offsetEst.y + flipY,
					};
				}
			}
			const trueTarget = clampWindowPosition(
				{
					x: cursor.x - session.grabOffset.x,
					y: cursor.y - session.grabOffset.y,
				},
				frame,
				display.workArea,
				MIN_VISIBLE_HEIGHT,
			);
			const command = {
				x: trueTarget.x + session.offsetEst.x,
				y: trueTarget.y + session.offsetEst.y,
			};
			session.lastCommand = command;
			this.window.setPosition(command.x, command.y);
			return;
		}
		const position = clampWindowPosition(
			{ x: cursor.x - session.offset.x, y: cursor.y - session.offset.y },
			frame,
			display.workArea,
		);
		this.window.setPosition(position.x, position.y);
	}
}
