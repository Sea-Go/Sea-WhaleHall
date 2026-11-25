import type { PetMood, PetState } from "../../shared/contracts";
import type { PetActionId } from "../../shared/pet-actions";
import { petRenderObserver } from "./renderers/pet-render-observer";
import { type AnimationContext, PetAnimator } from "./animations";
import type {
	PetAnchorId,
	PetEffect,
	PetFrame,
	PetHitZone,
	PetModel,
	PetProp,
	PetVector2,
} from "./core/types";
import {
	canvasPointToLocal,
	clamp,
	damp,
	facingFootprint,
	type Point,
	truncate,
} from "./pet-math";
import { spriteScreenRect } from "./debug-zone";

export type PetInteractionKind =
	| "hover"
	| "hoverEnd"
	| "click"
	| "doubleClick"
	| "rapidClick"
	| "pet"
	| "petEnd"
	| "poke"
	| "dragStart"
	| "dragEnd";

export interface PetInteractionEvent {
	kind: PetInteractionKind;
	action: PetActionId;
	modelId: string;
	zone: PetHitZone | null;
	canvasPoint: Point | null;
	localPoint: Point | null;
	pointerId?: number;
	dragDelta?: Point;
	/** pointerdown 时画布内的抓取点（CSS 像素，与窗口 DIP 同尺度）。 */
	grabPoint?: Point;
}

export interface PetRenderSnapshot {
	action: PetActionId;
	frame: Readonly<PetFrame>;
	modelId: string;
}

const EMPTY_MODEL: PetModel = {
	id: "__unset__",
	label: "",
	skeleton: {
		visualBounds: { x: 0, y: 0, width: 0, height: 0 },
		groundAnchor: { x: 0, y: 0 },
		anchors: [],
		hitZones: [],
	},
	theme: { colors: {} },
	draw() {},
	hitTest() {
		return null;
	},
	resolveAnchor() {
		return { x: 0, y: 0 };
	},
};

export interface CanvasPetRendererOptions {
	model?: PetModel;
	onInteract?: (event: PetInteractionEvent) => void;
	onFrame?: (snapshot: PetRenderSnapshot) => void;
}

export interface PetRenderer {
	mount(canvas: HTMLCanvasElement): void;
	setState(state: PetState): void;
	play(action: PetActionId): void;
	setModel(model: PetModel | string): void;
	dispose(): void;
}

interface ExtendedPetState extends PetState {
	action?: PetActionId;
	modelId?: string;
}

const PETTING_DISTANCE = 42;
const RAPID_CLICK_WINDOW_MS = 2_400;
const DOUBLE_CLICK_WINDOW_MS = 330;
// 场景原点自适应常数(与形象无关的窗口装饰带):
// 立足线固定在窗底以上 78px(聊天面板带),头顶余量自然留给消息气泡。
const BOTTOM_BAND_PX = 78;

function createNeutralFrame(): PetFrame {
	return {
		action: {
			id: "idle",
			elapsedSeconds: 0,
			progress: 0,
			phase: 0,
			visualCues: ["pose"],
		},
		root: {
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			facingX: 1,
			opacity: 1,
		},
		pose: {
			breath: 0,
			stretch: 0,
			crouch: 0,
			sit: 0,
			lie: 0,
			headTilt: 0,
			tailSwing: 0,
			primaryLimb: 0,
			secondaryLimb: 0,
			gaitPhase: 0,
			gaitWeight: 0,
			airborne: 0,
			squash: 0,
			lean: 0,
		},
		expression: {
			eyes: "open",
			eyeOpen: 1,
			look: { x: 0, y: 0 },
			mouth: "smile",
			blush: 0,
		},
		tone: "neutral",
		effects: [],
		props: [],
		shadow: { opacity: 1, scaleX: 1, scaleY: 1, offsetY: 0 },
	};
}

function cloneFrame(frame: PetFrame): PetFrame {
	return {
		...frame,
		action: { ...frame.action },
		root: { ...frame.root },
		pose: { ...frame.pose },
		expression: { ...frame.expression, look: { ...frame.expression.look } },
		effects: frame.effects.map((effect) => ({
			...effect,
			offset: { ...effect.offset },
		})),
		props: frame.props.map((prop) => ({ ...prop, offset: { ...prop.offset } })),
		shadow: { ...frame.shadow },
	};
}

/** Apply the exact scene transform shared by drawing, anchors and hit testing. */
export function modelLocalToCanvas(
	point: Point,
	origin: Point,
	frame: PetFrame,
): Point {
	const scaleX = frame.root.scaleX * frame.root.facingX;
	const scaleY = frame.root.scaleY;
	const scaledX = point.x * scaleX;
	const scaledY = point.y * scaleY;
	const cosine = Math.cos(frame.root.rotation);
	const sine = Math.sin(frame.root.rotation);
	return {
		x: origin.x + frame.root.x + scaledX * cosine - scaledY * sine,
		y: origin.y + frame.root.y + scaledX * sine + scaledY * cosine,
	};
}

export class CanvasPetRenderer implements PetRenderer {
	private canvas: HTMLCanvasElement | null = null;
	private context: CanvasRenderingContext2D | null = null;
	private animationFrame = 0;
	private model: PetModel;
	private animator: PetAnimator | null = null;
	private state: PetState = { mood: "idle", message: "WhaleHall" };
	private currentFrame: PetFrame = createNeutralFrame();
	private startedAt = 0;
	private lastFrameAt = 0;
	private reducedMotion = false;
	private hoverAmount = 0;
	private pressAmount = 0;
	private pointerCanvas: Point | null = null;
	private pointerLocal: Point = { x: 0, y: 0 };
	private hoverZone: PetHitZone | null = null;
	private pressedZone: PetHitZone | null = null;
	private activePointerId: number | null = null;
	private pressStart: Point | null = null;
	private previousPointer: Point | null = null;
	private dragStartedAt = 0;
	private dragging = false;
	private struggleStarted = false;
	private petting = false;
	private pettingDistance = 0;
	private clickTimes: number[] = [];
	private pendingAction: PetActionId | null = null;
	private readonly onInteract?: (event: PetInteractionEvent) => void;
	private readonly onFrame?: (snapshot: PetRenderSnapshot) => void;

	constructor(options: CanvasPetRendererOptions = {}) {
		// 形象由 PetState.pack 经 PetPackModelBridge 注入(标准 v1);
		// 构造期未提供时使用占位空模型,首帧 setModel 前不绘制形象。
		this.model = options.model ?? EMPTY_MODEL;
		this.onInteract = options.onInteract;
		this.onFrame = options.onFrame;
	}

	mount(canvas: HTMLCanvasElement): void {
		this.dispose();
		this.canvas = canvas;
		this.context = canvas.getContext("2d");
		if (!this.context) throw new Error("Canvas 2D context is unavailable.");
		this.startedAt = performance.now();
		this.lastFrameAt = this.startedAt;
		this.lastTickAt = this.startedAt;
		this.frameDebt = CanvasPetRenderer.MIN_FRAME_INTERVAL_MS;
		this.reducedMotion =
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
		this.animator = new PetAnimator(this.reducedMotion);
		this.animator.start(this.startedAt);
		if (this.pendingAction) this.play(this.pendingAction);
		void this.model.preload?.();
		window.addEventListener("resize", this.resize);
		canvas.addEventListener("pointermove", this.handlePointerMove);
		canvas.addEventListener("pointerleave", this.handlePointerLeave);
		canvas.addEventListener("pointerdown", this.handlePointerDown);
		canvas.addEventListener("pointerup", this.handlePointerUp);
		canvas.addEventListener("pointercancel", this.handlePointerCancel);
		canvas.addEventListener(
			"lostpointercapture",
			this.handleLostPointerCapture,
		);
		this.resize();
		this.applyChatBubbleAnchor();
		this.scheduleFrame();
	}

	setState(state: PetState): void {
		this.state = state;
		// 模型注入唯一入口是 setModel(PetModel):PetApp 依据 state.pack
		// 经 PetPackModelBridge 注入(标准 v1),此处不消费 modelId 字符串。
		this.applyStateAnimation(state);
	}

	private applyStateAnimation(state: PetState): void {
		const extended = state as ExtendedPetState;
		const action = extended.action ?? state.animation;
		const animator = this.animator;
		if (animator) {
			(
				animator.setMoodOrAnimation as (
					mood: PetMood,
					action: PetActionId | undefined,
					now: number,
				) => void
			)(state.mood, action, performance.now());
		} else if (action) {
			this.pendingAction = action;
		}
	}

	play(action: PetActionId): void {
		this.pendingAction = action;
		if (!this.animator) return;
		const now = performance.now();
		// Explicit playback is activity too (demo controls, commands, pointer
		// reactions); otherwise a long-idle sleep timer can immediately override it.
		this.animator.notifyInteraction(now);
		(this.animator.play as (action: PetActionId, now: number) => void)(
			action,
			now,
		);
	}

	setModel(model: PetModel): void {
		const nextModel = model;
		if (nextModel === this.model) return;
		this.model = nextModel;
		this.hoverZone = null;
		void nextModel.preload?.();
		this.refreshPointerHit();
		this.applyChatBubbleAnchor();
	}

	/** 外部触发一帧渲染(桥接模型图片加载就绪后调用)。 */
	requestRender(): void {
		this.scheduleFrame();
	}

	getModel(): PetModel {
		return this.model;
	}

	/**
	 * 对话气泡锚点（产品级，dev/生产一致）：把 .pet-chat 面板定位到当前
	 * 模型静息足迹的正下方——顶缘 = 立足线 + 5px，尾巴指向精灵水平中心，
	 * 经 CSS 变量写入舞台。面板高度 = 窗底距(8) 到顶缘的固定带，增长由
	 * 内部滚动消化；模型热切换时锚点随之迁移，模型间互不影响。
	 */
	private applyChatBubbleAnchor(): void {
		const stage = this.canvas?.parentElement;
		if (!stage) return;
		const width = this.canvas?.clientWidth ?? 0;
		const height = this.canvas?.clientHeight ?? 0;
		const origin = this.sceneOrigin(width, height);
		const bounds = this.model.skeleton.visualBounds;
		const floorY = origin.y + bounds.y + bounds.height;
		const centerX = origin.x + bounds.x + bounds.width / 2;
		stage.style.setProperty(
			"--pet-chat-top",
			`${Math.max(0, Math.round(floorY + 5))}px`,
		);
		stage.style.setProperty(
			"--pet-chat-tail-x",
			`${Math.max(0, Math.round(centerX))}px`,
		);
	}

	dispose(): void {
		if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
		this.framePending = false;
		this.lastTickAt = 0;
		this.frameDebt = 0;
		window.removeEventListener("resize", this.resize);
		this.canvas?.removeEventListener("pointermove", this.handlePointerMove);
		this.canvas?.removeEventListener("pointerleave", this.handlePointerLeave);
		this.canvas?.removeEventListener("pointerdown", this.handlePointerDown);
		this.canvas?.removeEventListener("pointerup", this.handlePointerUp);
		this.canvas?.removeEventListener("pointercancel", this.handlePointerCancel);
		this.canvas?.removeEventListener(
			"lostpointercapture",
			this.handleLostPointerCapture,
		);
		if (
			this.canvas &&
			this.activePointerId !== null &&
			this.canvas.hasPointerCapture?.(this.activePointerId)
		) {
			this.canvas.releasePointerCapture(this.activePointerId);
		}
		if (this.canvas) {
			this.canvas.style.cursor = "default";
			delete this.canvas.dataset.interaction;
			delete this.canvas.dataset.hitZone;
			delete this.canvas.dataset.model;
		}
		this.canvas = null;
		this.context = null;
		this.animator = null;
		this.animationFrame = 0;
		this.hoverAmount = 0;
		this.pressAmount = 0;
		this.messageBubble = null;
		this.pointerCanvas = null;
		this.pointerLocal = { x: 0, y: 0 };
		this.hoverZone = null;
		this.pressedZone = null;
		this.activePointerId = null;
		this.pressStart = null;
		this.previousPointer = null;
		this.dragging = false;
		this.struggleStarted = false;
		this.petting = false;
		this.pettingDistance = 0;
		this.clickTimes = [];
	}

	private readonly resize = () => {
		if (!this.canvas || !this.context) return;
		const rect = this.canvas.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
		this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
		this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
		// 尺寸变化后气泡锚点同步重推导（跨屏拖动会改变 DPR/几何）。
		this.applyChatBubbleAnchor();
	};

	private readonly handlePointerMove = (event: PointerEvent) => {
		const point = this.eventPoint(event);
		if (!point) return;
		this.pointerCanvas = point;
		this.pointerLocal = this.toLocalPoint(point);
		const zone = this.model.hitTest(
			this.pointerLocal,
			this.currentFrame,
			this.hoverZone ? 3 : 0,
		);
		this.setHoverZone(zone, event.pointerId);

		if (this.activePointerId === event.pointerId && this.pressStart) {
			const previous = this.previousPointer ?? this.pressStart;
			const stepX = point.x - previous.x;
			const stepY = point.y - previous.y;
			const totalX = point.x - this.pressStart.x;
			const totalY = point.y - this.pressStart.y;
			const distanceSquared = totalX * totalX + totalY * totalY;
			const startedOnHead =
				this.pressedZone === "head" || this.pressedZone === "face";
			const remainsOnHead = zone === "head" || zone === "face";

			if (!this.dragging && !this.petting && startedOnHead && remainsOnHead) {
				this.pettingDistance += Math.abs(stepX) + Math.abs(stepY) * 0.2;
				if (this.pettingDistance >= PETTING_DISTANCE && Math.abs(totalY) < 26) {
					this.petting = true;
					this.play("petHead");
					this.emit("pet", "petHead", zone, event.pointerId);
				}
			}

			const dragThreshold = startedOnHead && remainsOnHead ? 28 * 28 : 8 * 8;
			if (!this.dragging && !this.petting && distanceSquared > dragThreshold) {
				this.dragging = true;
				this.dragStartedAt = performance.now();
				this.play("dragged");
				this.emit(
					"dragStart",
					"dragged",
					this.pressedZone,
					event.pointerId,
					{
						x: totalX,
						y: totalY,
					},
					this.pressStart
						? { x: this.pressStart.x, y: this.pressStart.y }
						: undefined,
				);
			} else if (
				this.dragging &&
				!this.struggleStarted &&
				performance.now() - this.dragStartedAt > 180
			) {
				this.struggleStarted = true;
				this.play("dragStruggle");
			}
			this.previousPointer = point;
		}

		if (zone || this.activePointerId !== null) {
			this.animator?.notifyInteraction(performance.now());
		}
		this.updateCursor();
	};

	private readonly handlePointerLeave = (event: PointerEvent) => {
		if (this.activePointerId !== null) return;
		this.pointerCanvas = null;
		if (this.hoverZone) {
			this.emit("hoverEnd", "idle", this.hoverZone, event.pointerId);
		}
		this.hoverZone = null;
		if (this.hasActiveHoverAction()) this.applyStateAnimation(this.state);
		this.updateCursor();
	};

	private readonly handlePointerDown = (event: PointerEvent) => {
		if (event.button !== 0 || !this.canvas || this.activePointerId !== null)
			return;
		const point = this.eventPoint(event);
		if (!point) return;
		this.pointerCanvas = point;
		this.pointerLocal = this.toLocalPoint(point);
		const zone = this.model.hitTest(this.pointerLocal, this.currentFrame);
		if (!zone) return;
		event.preventDefault();
		this.hoverZone = zone;
		this.pressedZone = zone;
		this.activePointerId = event.pointerId;
		this.pressStart = point;
		this.previousPointer = point;
		this.dragging = false;
		this.struggleStarted = false;
		this.petting = false;
		this.pettingDistance = 0;
		this.canvas.setPointerCapture?.(event.pointerId);
		this.animator?.notifyInteraction(performance.now());
		this.updateCursor();
	};

	private readonly handlePointerUp = (event: PointerEvent) => {
		if (event.pointerId !== this.activePointerId || !this.canvas) return;
		const point = this.eventPoint(event);
		if (point) {
			this.pointerCanvas = point;
			this.pointerLocal = this.toLocalPoint(point);
		}
		const releaseZone = point
			? this.model.hitTest(this.pointerLocal, this.currentFrame)
			: null;
		const releaseTolerance = point
			? this.model.hitTest(this.pointerLocal, this.currentFrame, 12)
			: null;
		const pointerId = this.activePointerId;
		const dragDelta =
			point && this.pressStart
				? { x: point.x - this.pressStart.x, y: point.y - this.pressStart.y }
				: { x: 0, y: 0 };

		if (this.dragging) {
			this.play("drop");
			this.emit(
				"dragEnd",
				"drop",
				releaseZone ?? this.pressedZone,
				pointerId,
				dragDelta,
			);
		} else if (this.petting) {
			// petHead is intentionally a loop while the stroke is active. Releasing
			// must leave that loop; keep pointer-aware feedback when still hovering.
			const action = releaseZone ? "hoverLookAtPointer" : "idle";
			this.play(action);
			this.emit("petEnd", action, releaseZone ?? this.pressedZone, pointerId);
		} else if (!this.petting && releaseTolerance) {
			this.handleClick(pointerId, releaseZone ?? releaseTolerance);
		}

		this.releasePointer(pointerId);
		this.hoverZone = releaseZone;
		this.updateCursor();
		this.animator?.notifyInteraction(performance.now());
	};

	private readonly handlePointerCancel = (event: PointerEvent) => {
		if (event.pointerId !== this.activePointerId) return;
		this.cancelPointer(event.pointerId);
	};

	private readonly handleLostPointerCapture = (event: PointerEvent) => {
		if (event.pointerId !== this.activePointerId) return;
		this.cancelPointer(event.pointerId);
	};

	private handleClick(pointerId: number, zone: PetHitZone): void {
		const now = performance.now();
		this.clickTimes = this.clickTimes.filter(
			(time) => now - time <= RAPID_CLICK_WINDOW_MS,
		);
		const previousClick = this.clickTimes.at(-1);
		this.clickTimes.push(now);

		if (this.clickTimes.length >= 4) {
			this.play("rapidClickAnnoyed");
			this.emit("rapidClick", "rapidClickAnnoyed", zone, pointerId);
			this.clickTimes = [];
			return;
		}
		if (
			previousClick !== undefined &&
			now - previousClick <= DOUBLE_CLICK_WINDOW_MS
		) {
			this.play("doubleClick");
			this.emit("doubleClick", "doubleClick", zone, pointerId);
			return;
		}

		const action: PetActionId =
			zone === "face"
				? "pokeFace"
				: zone === "body"
					? "pokeBody"
					: "clickFeedback";
		this.play(action);
		this.emit("click", action, zone, pointerId);
		if (action === "pokeFace" || action === "pokeBody") {
			this.emit("poke", action, zone, pointerId);
		}
	}

	private cancelPointer(pointerId: number): void {
		if (this.dragging) {
			this.play("drop");
			this.emit("dragEnd", "drop", this.pressedZone, pointerId, { x: 0, y: 0 });
		} else if (this.petting) {
			this.play("idle");
			this.emit("petEnd", "idle", this.pressedZone, pointerId);
		} else if (this.hoverZone || this.pressedZone) {
			if (this.hasActiveHoverAction()) this.applyStateAnimation(this.state);
			this.emit(
				"hoverEnd",
				"idle",
				this.hoverZone ?? this.pressedZone,
				pointerId,
			);
		}
		this.releasePointer(pointerId);
		this.hoverZone = null;
		this.updateCursor();
	}

	private releasePointer(pointerId: number): void {
		if (this.canvas?.hasPointerCapture?.(pointerId)) {
			this.canvas.releasePointerCapture(pointerId);
		}
		this.activePointerId = null;
		this.pressedZone = null;
		this.pressStart = null;
		this.previousPointer = null;
		this.dragging = false;
		this.struggleStarted = false;
		this.petting = false;
		this.pettingDistance = 0;
	}

	private setHoverZone(zone: PetHitZone | null, pointerId?: number): void {
		const previous = this.hoverZone;
		this.hoverZone = zone;
		if (!previous && zone && this.activePointerId === null) {
			this.play("hoverLookAtPointer");
			this.emit("hover", "hoverLookAtPointer", zone, pointerId);
		} else if (previous && !zone && this.activePointerId === null) {
			this.emit("hoverEnd", "idle", previous, pointerId);
			if (this.hasActiveHoverAction()) this.applyStateAnimation(this.state);
		}
	}

	private hasActiveHoverAction(): boolean {
		const action = this.animator?.getCurrentAction() ?? this.pendingAction;
		return action === "hoverLookAtPointer" || action === "trackPointerGaze";
	}

	private emit(
		kind: PetInteractionKind,
		action: PetActionId,
		zone: PetHitZone | null,
		pointerId?: number,
		dragDelta?: Point,
		grabPoint?: Point,
	): void {
		this.onInteract?.({
			kind,
			action,
			modelId: this.model.id,
			zone,
			canvasPoint: this.pointerCanvas ? { ...this.pointerCanvas } : null,
			localPoint: this.pointerCanvas ? { ...this.pointerLocal } : null,
			pointerId,
			dragDelta,
			grabPoint,
		});
	}

	private eventPoint(event: PointerEvent): Point | null {
		if (!this.canvas) return null;
		const rect = this.canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	/**
	 * 场景原点由模型视觉包围盒自适应推导(替代为鲸鱼非对称足迹调死的
	 * 固定比例):水平方向包围盒居中;垂直方向立足线(包围盒底)固定在
	 * 窗底装饰带之上。空模型(0 尺寸)退化为窗口中心,不绘制任何形象。
	 */
	private sceneOrigin(
		width = this.canvas?.clientWidth ?? 0,
		height = this.canvas?.clientHeight ?? 0,
	): Point {
		const bounds = this.model.skeleton.visualBounds;
		return {
			x: width / 2 - (bounds.x + bounds.width / 2),
			y:
				height -
				BOTTOM_BAND_PX -
				(bounds.y + bounds.height),
		};
	}

	private toLocalPoint(point: Point): Point {
		const origin = this.sceneOrigin();
		const frame = this.currentFrame;
		return canvasPointToLocal(point, {
			x: origin.x + frame.root.x,
			y: origin.y + frame.root.y,
			rotation: frame.root.rotation,
			scaleX: frame.root.scaleX * frame.root.facingX,
			scaleY: frame.root.scaleY,
		});
	}

	private refreshPointerHit(): void {
		if (!this.pointerCanvas) return;
		this.pointerLocal = this.toLocalPoint(this.pointerCanvas);
		const zone = this.model.hitTest(
			this.pointerLocal,
			this.currentFrame,
			this.hoverZone ? 3 : 0,
		);
		// The pet itself can move under a stationary cursor, so frame-driven hit
		// changes must pass through the same hover FSM as pointermove events.
		this.setHoverZone(zone);
		this.updateCursor();
	}

	private updateCursor(): void {
		if (!this.canvas) return;
		this.canvas.style.cursor = this.dragging
			? "grabbing"
			: this.activePointerId !== null
				? "grab"
				: this.hoverZone
					? "pointer"
					: "default";
		this.canvas.dataset.interaction = this.dragging
			? "drag"
			: this.activePointerId !== null
				? "press"
				: this.hoverZone
					? "hover"
					: "idle";
		this.canvas.dataset.model = this.model.id;
		if (this.hoverZone) this.canvas.dataset.hitZone = this.hoverZone;
		else delete this.canvas.dataset.hitZone;
	}

	private lastTickAt = 0;
	private frameDebt = 0;
	private framePending = false;
	private static readonly MIN_FRAME_INTERVAL_MS = 1000 / 60; // 60fps 上限

	/**
	 * 合并所有渲染触发源为单一待决帧。直接 render() 调用(图片就绪回调等)
	 * 与 rAF 回调若各自再排 rAF,会繁殖出无法取消的并行链(animationFrame
	 * 只保存最后一个句柄)——多条空转链让帧间隔抖动、图片查询计数暴涨。
	 * 任何时刻至多一个待决 rAF;dispose 取消它即彻底停机。
	 */
	private scheduleFrame(): void {
		if (this.framePending || !this.canvas) return;
		this.framePending = true;
		this.animationFrame = requestAnimationFrame(this.render);
	}

	private readonly render = (now: number) => {
		this.framePending = false;
		if (!this.canvas) return;
		petRenderObserver.onTick(now);
		// 帧率上限 60fps(素材与动画计时都不超过 60,更高刷新只是重复绘制):
		// 按自上次渲染以来累计的时间判定,到点即渲染并扣掉一个间隔,欠账至多
		// 保留一个间隔(卡顿后不连发补帧)。不能用"距上一帧 ≥ 间隔"的硬门槛
		// ——rAF 节拍与目标间隔同量级(60Hz)时,时间戳抖动会把约 1/3 的刷新
		// 误判为太早而丢弃(实测 raf=60Hz 只渲染出 40fps)。
		this.frameDebt += Math.min(100, Math.max(0, now - this.lastTickAt));
		this.lastTickAt = now;
		if (this.frameDebt + 1 < CanvasPetRenderer.MIN_FRAME_INTERVAL_MS) {
			this.scheduleFrame();
			return;
		}
		this.frameDebt = Math.min(
			this.frameDebt - CanvasPetRenderer.MIN_FRAME_INTERVAL_MS,
			CanvasPetRenderer.MIN_FRAME_INTERVAL_MS,
		);
		petRenderObserver.onFrameStart(now);
		const renderStart = performance.now();
		try {
			this.drawFrame(now);
		} catch (error) {
			// 单帧异常不能杀死 rAF 循环：clearRect 之后抛错会让桌宠永久空白。
			console.error(
				"[pet] render frame failed",
				error instanceof Error ? `${error.message} @ ${error.stack?.split("\n")[1]?.trim() ?? ""}` : String(error),
			);
		}
		petRenderObserver.onFrameEnd(performance.now(), renderStart);
		this.scheduleFrame();
	};

	private drawFrame(now: number): void {
		if (!this.canvas || !this.context || !this.animator) return;
		const context = this.context;
		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		// 跨显示器拖动改变 devicePixelRatio 但不触发 window resize：canvas
		// backing 停在旧 DPR 尺寸 → 每帧精灵按旧尺寸绘制被新屏压缩（鲸鱼
		// "变小"）、clearRect 清不完超配区域（旧帧残影竖条）。每帧核对
		// backing 与当前 DPR 的匹配，失配即重建。
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		if (
			this.canvas.width !== Math.max(1, Math.round(width * dpr)) ||
			this.canvas.height !== Math.max(1, Math.round(height * dpr))
		) {
			this.resize();
		}
		const time = (now - this.startedAt) / 1000;
		const deltaSeconds = Math.min(
			0.05,
			Math.max(0, (now - this.lastFrameAt) / 1000),
		);
		this.lastFrameAt = now;

		// The canvas is transparent; clearing every frame is required to avoid trails.
		context.clearRect(0, 0, width, height);
		this.hoverAmount = damp(
			this.hoverAmount,
			this.hoverZone ? 1 : 0,
			13,
			deltaSeconds,
		);
		this.pressAmount = damp(
			this.pressAmount,
			this.activePointerId !== null ? 1 : 0,
			20,
			deltaSeconds,
		);

		const origin = this.sceneOrigin(width, height);
		const animationContext = this.buildAnimationContext(
			width,
			height,
			origin,
			time,
			deltaSeconds,
		);
		const animated = this.animator.update(
			animationContext,
			now,
		) as unknown as PetFrame;
		const frame = cloneFrame(animated);
		if (this.pressAmount > 0 && !this.dragging && !this.petting) {
			frame.root.scaleX *= 1 + this.pressAmount * 0.07;
			frame.root.scaleY *= 1 - this.pressAmount * 0.09;
		}
		this.currentFrame = frame;
		this.refreshPointerHit();

		// dev 调试框画在桌宠之下：精灵压过下缘线，读作"站在框的立足线上"。
		if (this.state.debugOverlays) {
			this.drawDebugActivityZone(context, origin, frame);
		}
		this.drawShadow(context, origin, frame);
		context.save();
		context.globalAlpha = clamp(frame.root.opacity, 0, 1);
		context.translate(origin.x + frame.root.x, origin.y + frame.root.y);
		context.rotate(frame.root.rotation);
		context.scale(frame.root.scaleX * frame.root.facingX, frame.root.scaleY);
		this.model.draw(context, frame);
		context.restore();

		const visualTime = this.reducedMotion ? 0 : time;
		if (!this.model.selfContainedOverlays) {
			for (const effect of frame.effects)
				this.drawEffect(context, origin, frame, effect, visualTime);
			for (const prop of frame.props) this.drawProp(context, origin, frame, prop);
		}
		if (
			this.hoverAmount > 0.04 &&
			!frame.effects.some(({ kind }) => kind === "sparkle")
		) {
			this.drawAmbientSparkles(
				context,
				origin,
				frame,
				visualTime,
				this.hoverAmount,
			);
		}
		this.drawMessage(context, width, height, origin, frame);

		this.onFrame?.({ action: frame.action.id, frame, modelId: this.model.id });
	}

	private buildAnimationContext(
		width: number,
		height: number,
		origin: Point,
		time: number,
		deltaSeconds: number,
	): AnimationContext {
		const visualBounds = this.model.skeleton.visualBounds;
		const aim = {
			x: clamp(
				this.pointerLocal.x / Math.max(40, visualBounds.width * 0.45),
				-1,
				1,
			),
			y: clamp(
				this.pointerLocal.y / Math.max(35, visualBounds.height * 0.42),
				-1,
				1,
			),
		};
		const dragDelta =
			this.pointerCanvas && this.pressStart
				? {
						x: this.pointerCanvas.x - this.pressStart.x,
						y: this.pointerCanvas.y - this.pressStart.y,
					}
				: { x: 0, y: 0 };
		// 行走夹紧按当前朝向取有效足迹：非对称包围盒翻面后左右互换,
		// 按原始包络夹紧会让朝左贴右边界时镜像尾巴越出窗外。活动范围
		// 覆盖整个窗口宽度(原点自适应推导,不再用固定比例)。
		const facing = this.currentFrame?.root.facingX ?? 1;
		const footprint = facingFootprint(visualBounds, facing);
		return {
			width,
			height,
			travelBounds: {
				minX: -origin.x - footprint.x,
				maxX: width - origin.x - footprint.x - footprint.width,
			},
			time,
			deltaSeconds,
			reducedMotion: this.reducedMotion,
			pointerLocal: this.pointerLocal,
			aim,
			dragDelta,
			message: this.state.message,
			hoverAmount: this.hoverAmount,
			pressAmount: this.pressAmount,
		};
	}

	/**
	 * dev 专属（PetState.debugOverlays）：把"活动区接触范围"画成紧贴精灵
	 * 的虚线框——由模型声明的 visualBounds + 当前帧 root 变换推导屏幕
	 * AABB（spriteScreenRect），模型无关：鲸鱼/橘子猫/DeepSeek 各自贴各自
	 * 的精灵，互不影响。画在桌宠之下：精灵压过边线，边框读作"贴着"。
	 */
	private drawDebugActivityZone(
		context: CanvasRenderingContext2D,
		origin: Point,
		frame: PetFrame,
	): void {
		const rect = spriteScreenRect(
			this.model.skeleton.visualBounds,
			frame.root,
			origin,
		);
		context.save();
		context.setLineDash([6, 4]);
		context.lineWidth = 1.5;
		context.strokeStyle = "rgba(83, 200, 216, 0.85)";
		context.fillStyle = "rgba(83, 200, 216, 0.05)";
		context.fillRect(rect.x, rect.y, rect.width, rect.height);
		context.strokeRect(rect.x, rect.y, rect.width, rect.height);
		context.setLineDash([]);
		context.font = "700 9px ui-sans-serif, system-ui, sans-serif";
		// 标签不截断:pill 宽度按实测文本自适应,"活动区 192×208" 必须完整可读。
		const label = `活动区 ${Math.round(rect.width)}×${Math.round(rect.height)}`;
		const textWidth = context.measureText(label).width;
		const pillX = rect.x + 4;
		// 标签放框外上方:框内左上角会被角色发丝遮挡("208" 被盖读作截断)。
		const pillY = Math.max(2, rect.y - 18);
		const pillW = textWidth + 12;
		const pillH = 15;
		context.fillStyle = "rgba(83, 200, 216, 0.78)";
		if (typeof context.roundRect === "function") {
			context.beginPath();
			context.roundRect(pillX, pillY, pillW, pillH, 999);
			context.fill();
		} else {
			context.fillRect(pillX, pillY, pillW, pillH);
		}
		context.fillStyle = "rgba(6, 32, 40, 0.95)";
		context.textBaseline = "middle";
		context.fillText(label, pillX + 6, pillY + pillH / 2 + 0.5);
		context.restore();
	}

	private drawShadow(
		context: CanvasRenderingContext2D,
		origin: Point,
		frame: PetFrame,
	): void {
		if (frame.shadow.opacity <= 0 || frame.root.opacity <= 0) return;
		const ground = this.model.resolveAnchor("ground", frame);
		const width = this.model.skeleton.visualBounds.width;
		const centerX =
			origin.x +
			frame.root.x +
			ground.x * frame.root.scaleX * frame.root.facingX;
		// Vertical root motion represents jumping; the shadow remains on the ground.
		const centerY =
			origin.y + ground.y * frame.root.scaleY + frame.shadow.offsetY;
		const radiusX = Math.max(45, width * 0.36) * frame.shadow.scaleX;
		// 阴影主体收在活动区内:立足线即框底,半径 9 + 上移 3 让下缘
		// 只越线 ~6px(此前 ry14 满越 14px,读作"框没框住脚下")。
		const radiusY = 9 * frame.shadow.scaleY;
		context.save();
		context.translate(centerX, centerY - 3);
		const gradient = context.createRadialGradient(0, 0, 4, 0, 0, radiusX);
		gradient.addColorStop(
			0,
			`rgba(0, 19, 28, ${0.26 * frame.shadow.opacity * frame.root.opacity})`,
		);
		gradient.addColorStop(1, "rgba(0, 19, 28, 0)");
		context.fillStyle = gradient;
		context.beginPath();
		context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
		context.fill();
		context.restore();
	}

	private effectPosition(
		origin: Point,
		frame: PetFrame,
		effect: PetEffect,
	): Point {
		const anchor = this.model.resolveAnchor(effect.anchor, frame);
		const canvas = modelLocalToCanvas(anchor, origin, frame);
		return { x: canvas.x + effect.offset.x, y: canvas.y + effect.offset.y };
	}

	private drawEffect(
		context: CanvasRenderingContext2D,
		origin: Point,
		frame: PetFrame,
		effect: PetEffect,
		time: number,
	): void {
		const point = this.effectPosition(origin, frame, effect);
		const alpha = clamp(effect.opacity * frame.root.opacity, 0, 1);
		if (alpha <= 0) return;
		const intensity = 0.65 + clamp(effect.intensity, 0, 1) * 0.7;
		context.save();
		context.translate(point.x, point.y);
		context.globalAlpha = alpha;
		context.lineCap = "round";
		context.lineJoin = "round";

		switch (effect.kind) {
			case "sparkle":
			case "clean":
			case "outfit":
			case "gift":
			case "confetti": {
				const colors = ["#fff1a8", "#a9fff0", "#ff9fbe", "#a9cfff"];
				const count = effect.kind === "confetti" ? 10 : 5;
				for (let index = 0; index < count; index += 1) {
					const angle = (Math.PI * 2 * index) / count + time * 0.25;
					const travel = 20 + effect.progress * 42 + (index % 3) * 5;
					const x = Math.cos(angle) * travel;
					const y = Math.sin(angle) * travel * 0.7 - effect.progress * 12;
					context.strokeStyle = colors[index % colors.length] ?? "#fff1a8";
					context.fillStyle = context.strokeStyle;
					context.lineWidth = 2.2;
					if (effect.kind === "confetti") {
						context.fillRect(x - 2, y - 4, 4, 8);
					} else {
						const size = 3 + intensity * 2 + Math.sin(time * 4 + index) * 1.2;
						context.beginPath();
						context.moveTo(x - size, y);
						context.lineTo(x + size, y);
						context.moveTo(x, y - size);
						context.lineTo(x, y + size);
						context.stroke();
					}
				}
				break;
			}
			case "heart": {
				for (let index = 0; index < 3; index += 1) {
					const rise = ((time * 22 + index * 15) % 48) + effect.progress * 8;
					const x = (index - 1) * 18 + Math.sin(time * 2 + index) * 3;
					context.fillStyle = "#ff6298";
					context.globalAlpha = alpha * Math.max(0.15, 1 - rise / 58);
					context.save();
					context.translate(x, -rise);
					context.scale(intensity, intensity);
					context.beginPath();
					context.moveTo(0, 6);
					context.bezierCurveTo(-9, -1, -6, -9, 0, -4);
					context.bezierCurveTo(6, -9, 9, -1, 0, 6);
					context.fill();
					context.restore();
				}
				break;
			}
			case "tear":
			case "sweat":
			case "water":
			case "weather": {
				const count =
					effect.kind === "water" || effect.kind === "weather" ? 5 : 2;
				context.fillStyle = "#8cdfff";
				for (let index = 0; index < count; index += 1) {
					const fall = this.reducedMotion
						? index * 7
						: (time * 28 + index * 13) % 38;
					const x = (index - (count - 1) / 2) * 12;
					context.beginPath();
					context.ellipse(
						x,
						7 + fall,
						2.5 * intensity,
						4.5 * intensity,
						0,
						0,
						Math.PI * 2,
					);
					context.fill();
				}
				break;
			}
			case "questionMark":
			case "exclamationMark":
			case "errorMark": {
				const mark = effect.kind === "questionMark" ? "?" : "!";
				context.fillStyle = effect.kind === "errorMark" ? "#ff718b" : "#ffe58f";
				context.beginPath();
				context.arc(0, 0, 13 * intensity, 0, Math.PI * 2);
				context.fill();
				context.fillStyle = effect.kind === "errorMark" ? "#fff" : "#51452a";
				context.font = `800 ${17 * intensity}px ui-rounded, system-ui, sans-serif`;
				context.textAlign = "center";
				context.textBaseline = "middle";
				context.fillText(mark, 0, 1);
				break;
			}
			case "food":
			case "medicine":
			case "timer":
			case "sign": {
				const glyph =
					effect.kind === "food"
						? "●"
						: effect.kind === "medicine"
							? "◆"
							: effect.kind === "timer"
								? "◷"
								: "!";
				const color =
					effect.kind === "food"
						? "#ef6d63"
						: effect.kind === "medicine"
							? "#ef8d9a"
							: effect.kind === "timer"
								? "#ef786e"
								: "#ffe39a";
				context.fillStyle = "rgba(7, 24, 33, 0.28)";
				context.beginPath();
				context.roundRect(-15, -14, 30, 30, 10);
				context.fill();
				context.fillStyle = color;
				context.beginPath();
				context.roundRect(-15, -16, 30, 29, 10);
				context.fill();
				context.fillStyle = effect.kind === "sign" ? "#57492d" : "#fff";
				context.font = "800 16px ui-rounded, system-ui, sans-serif";
				context.textAlign = "center";
				context.textBaseline = "middle";
				context.fillText(glyph, 0, -1);
				break;
			}
			case "zzz":
			case "bubble": {
				if (effect.kind === "zzz") {
					context.fillStyle = "#d9efff";
					context.font = `800 ${15 * intensity}px ui-rounded, system-ui, sans-serif`;
					context.fillText("Z", 0, -effect.progress * 18);
					context.globalAlpha *= 0.65;
					context.fillText("z", 15, -13 - effect.progress * 12);
				} else {
					context.strokeStyle = "#bceeff";
					context.lineWidth = 2;
					for (let index = 0; index < 3; index += 1) {
						const rise = this.reducedMotion
							? index * 13
							: (time * 24 + index * 17) % 48;
						context.beginPath();
						context.arc(
							index * 12 - 12,
							-rise,
							4 + index * 1.5,
							0,
							Math.PI * 2,
						);
						context.stroke();
					}
				}
				break;
			}
			case "angerMark": {
				context.strokeStyle = "#ff5f70";
				context.lineWidth = 3.5;
				context.beginPath();
				context.moveTo(-11, -3);
				context.lineTo(-3, -3);
				context.lineTo(-3, -11);
				context.moveTo(3, -11);
				context.lineTo(3, -3);
				context.lineTo(11, -3);
				context.moveTo(-11, 3);
				context.lineTo(-3, 3);
				context.lineTo(-3, 11);
				context.moveTo(3, 11);
				context.lineTo(3, 3);
				context.lineTo(11, 3);
				context.stroke();
				break;
			}
			case "motionLines":
			case "soundWave": {
				context.strokeStyle =
					effect.kind === "soundWave" ? "#b5f7ff" : "#d8f7ff";
				context.lineWidth = 2.2;
				for (let index = 0; index < 3; index += 1) {
					context.beginPath();
					if (effect.kind === "soundWave") {
						context.arc(0, 0, 10 + index * 8, -0.9, 0.9);
					} else {
						const y = (index - 1) * 11;
						context.moveTo(-28 - index * 6, y);
						context.lineTo(-7, y);
					}
					context.stroke();
				}
				break;
			}
			case "spinner": {
				context.strokeStyle = "#b9f7f2";
				context.lineWidth = 4;
				context.beginPath();
				context.arc(0, 0, 13, time * 4, time * 4 + Math.PI * 1.45);
				context.stroke();
				break;
			}
			case "notification":
			case "offlineBadge": {
				context.fillStyle =
					effect.kind === "offlineBadge" ? "#5d6477" : "#ff6178";
				context.beginPath();
				context.roundRect(-14, -11, 28, 22, 11);
				context.fill();
				context.fillStyle = "#fff";
				context.font = "800 13px ui-rounded, system-ui, sans-serif";
				context.textAlign = "center";
				context.textBaseline = "middle";
				context.fillText(effect.kind === "offlineBadge" ? "×" : "1", 0, 0);
				break;
			}
			case "impact": {
				context.strokeStyle = "#fff0a1";
				context.lineWidth = 3;
				for (let index = 0; index < 8; index += 1) {
					const angle = (Math.PI * 2 * index) / 8;
					context.beginPath();
					context.moveTo(Math.cos(angle) * 8, Math.sin(angle) * 8);
					context.lineTo(
						Math.cos(angle) * 18 * intensity,
						Math.sin(angle) * 18 * intensity,
					);
					context.stroke();
				}
				break;
			}
			case "dust": {
				context.fillStyle = "#d9e4e5";
				for (let index = 0; index < 4; index += 1) {
					context.globalAlpha = alpha * (0.75 - index * 0.12);
					context.beginPath();
					context.arc(-18 + index * 12, -index * 2, 7 - index, 0, Math.PI * 2);
					context.fill();
				}
				break;
			}
			case "screenEdge": {
				context.strokeStyle = "#b7e9f3";
				context.lineWidth = 3;
				context.beginPath();
				context.moveTo(-5, -28);
				context.lineTo(-5, 28);
				context.moveTo(-5, -20);
				context.lineTo(8, -20);
				context.moveTo(-5, 20);
				context.lineTo(8, 20);
				context.stroke();
				break;
			}
			default:
				break;
		}
		context.restore();
	}

	private drawProp(
		context: CanvasRenderingContext2D,
		origin: Point,
		frame: PetFrame,
		prop: PetProp,
	): void {
		const anchor = this.model.resolveAnchor(prop.anchor, frame);
		const point = modelLocalToCanvas(anchor, origin, frame);
		const glyphs: Record<PetProp["kind"], string> = {
			food: "●",
			drink: "▱",
			towel: "▥",
			brush: "╱",
			toy: "◉",
			book: "▤",
			phone: "▯",
			headphones: "Ω",
			medicine: "◆",
			gift: "✦",
			outfit: "♢",
			sign: prop.text ? "" : "!",
			notification: "1",
			magnifier: "⌕",
			notebook: "≡",
			timer: "◷",
			alarm: "◴",
			umbrella: "⌒",
			fan: "✤",
			holiday: "★",
			mystery: "?",
		};
		const palette: Record<PetProp["kind"], string> = {
			food: "#ef6d63",
			drink: "#73cdec",
			towel: "#b7e6d5",
			brush: "#e4a86d",
			toy: "#aa8bf0",
			book: "#668ccb",
			phone: "#4d5e7c",
			headphones: "#a97bc6",
			medicine: "#ef8d9a",
			gift: "#ef7188",
			outfit: "#f0ab70",
			sign: "#ffe39a",
			notification: "#ff6178",
			magnifier: "#7dcbd4",
			notebook: "#77a4d8",
			timer: "#ef786e",
			alarm: "#f19263",
			umbrella: "#75a8dc",
			fan: "#72c9b9",
			holiday: "#db9e4c",
			mystery: "#9d8bc6",
		};
		const scale = Math.max(0.2, prop.scale) * (0.9 + prop.progress * 0.1);
		context.save();
		context.translate(point.x + prop.offset.x, point.y + prop.offset.y);
		context.rotate(prop.rotation * frame.root.facingX);
		context.scale(scale, scale);
		context.globalAlpha = clamp(prop.opacity * frame.root.opacity, 0, 1);
		context.fillStyle = "rgba(10, 25, 35, 0.25)";
		context.beginPath();
		context.roundRect(-19, -17, 38, 36, 12);
		context.fill();
		context.fillStyle = palette[prop.kind];
		context.beginPath();
		context.roundRect(-18, -19, 36, 35, 11);
		context.fill();
		context.strokeStyle = "rgba(255,255,255,0.48)";
		context.lineWidth = 1.5;
		context.stroke();
		context.fillStyle = prop.kind === "sign" ? "#594c2d" : "#fff";
		context.font = `${prop.kind === "sign" && prop.text ? "700 9px" : "800 20px"} ui-rounded, system-ui, sans-serif`;
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillText(
			prop.kind === "sign" && prop.text
				? truncate(prop.text, 8)
				: glyphs[prop.kind],
			0,
			-1,
			30,
		);
		context.restore();
	}

	private drawAmbientSparkles(
		context: CanvasRenderingContext2D,
		origin: Point,
		frame: PetFrame,
		time: number,
		amount: number,
	): void {
		const bounds = this.model.skeleton.visualBounds;
		const center = modelLocalToCanvas(
			{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
			origin,
			frame,
		);
		const locations = [
			{ x: -bounds.width * 0.42, y: -bounds.height * 0.34, phase: 0 },
			{ x: bounds.width * 0.4, y: -bounds.height * 0.28, phase: 1.7 },
			{ x: bounds.width * 0.43, y: bounds.height * 0.18, phase: 3.2 },
		];
		context.save();
		context.translate(center.x, center.y);
		context.strokeStyle = `rgba(222, 255, 242, ${0.2 + amount * 0.62})`;
		context.lineWidth = 2;
		for (const sparkle of locations) {
			const size = 4 + Math.sin(time * 4 + sparkle.phase) * 1.4;
			context.beginPath();
			context.moveTo(sparkle.x - size, sparkle.y);
			context.lineTo(sparkle.x + size, sparkle.y);
			context.moveTo(sparkle.x, sparkle.y - size);
			context.lineTo(sparkle.x, sparkle.y + size);
			context.stroke();
		}
		context.restore();
	}

	private messageBubble: { key: string; canvas: HTMLCanvasElement } | null =
		null;

	private drawMessage(
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
		origin: Point,
		frame: PetFrame,
	): void {
		const text = truncate(this.state.message, 42);
		if (!text) return;
		const anchor = this.model.resolveAnchor("message", frame);
		const anchorCanvas = modelLocalToCanvas(anchor, origin, frame);
		context.font = "600 12px ui-rounded, system-ui, sans-serif";
		const measured = context.measureText(text).width;
		const bubbleWidth = Math.max(56, Math.min(width - 24, measured + 28));
		const x = clamp(
			anchorCanvas.x - bubbleWidth / 2,
			10,
			Math.max(10, width - bubbleWidth - 10),
		);
		const y = clamp(anchorCanvas.y, 8, Math.max(8, height - 34));
		context.drawImage(
			this.cachedMessageBubble(text, Math.round(bubbleWidth)),
			x - 12,
			y - 12,
			bubbleWidth + 24,
			28 + 24,
		);
	}

	/**
	 * 气泡带 12px 阴影模糊，逐帧直绘会让 GPU 进程每帧做一次 CPU 高斯模糊
	 * （CA::CG::DrawPathShadow → vImageConvolve），实测能把渲染管线堵死到
	 * 画面冻结。这里只在文本或气泡宽度变化时重建一次位图，帧循环只 drawImage。
	 */
	private cachedMessageBubble(
		text: string,
		bubbleWidth: number,
	): HTMLCanvasElement {
		const key = `${bubbleWidth}|${text}`;
		if (this.messageBubble?.key === key) return this.messageBubble.canvas;
		const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
		const canvas = document.createElement("canvas");
		canvas.width = Math.ceil((bubbleWidth + 24) * scale);
		canvas.height = Math.ceil((28 + 24) * scale);
		const bubble = canvas.getContext("2d");
		if (bubble) {
			bubble.scale(scale, scale);
			bubble.translate(12, 12);
			bubble.font = "600 12px ui-rounded, system-ui, sans-serif";
			bubble.fillStyle = "rgba(5, 22, 31, 0.84)";
			bubble.shadowColor = "rgba(0, 0, 0, 0.2)";
			bubble.shadowBlur = 12;
			bubble.beginPath();
			bubble.roundRect(0, 0, bubbleWidth, 28, 14);
			bubble.fill();
			bubble.shadowBlur = 0;
			bubble.strokeStyle = "rgba(220, 255, 255, 0.16)";
			bubble.lineWidth = 1;
			bubble.stroke();
			bubble.fillStyle = "rgba(232, 252, 255, 0.96)";
			bubble.textAlign = "center";
			bubble.textBaseline = "middle";
			bubble.fillText(text, bubbleWidth / 2, 14, bubbleWidth - 16);
		}
		this.messageBubble = { key, canvas };
		return canvas;
	}
}


