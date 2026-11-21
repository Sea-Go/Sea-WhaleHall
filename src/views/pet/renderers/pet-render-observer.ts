/**
 * 桌宠渲染观测台(《桌宠包标准 v1》配套可观测性)。
 *
 * 埋点维度:帧率/掉帧/渲染耗时/图片加载/动作切换/窗口可见性。
 * 每维度带原因标记,汇总周期性推送到 console 与 data-* 属性
 * (截图工具可读,诊断脚本可采)。零形象知识。
 */

export interface PetRenderMetrics {
	/** 自观测启动以来的总渲染帧数。 */
	framesRendered: number;
	/** 掉帧数(渲染间隔 > 预算 2 倍)。 */
	framesDropped: number;
	/** 掉帧原因计数。 */
	dropReasons: Readonly<Record<string, number>>;
	/** 最近 60 帧平均渲染耗时(ms)。 */
	avgRenderMs: number;
	/** 最近 60 帧最大渲染耗时(ms)。 */
	maxRenderMs: number;
	/** 最近 60 帧平均帧间隔(ms)。 */
	avgFrameIntervalMs: number;
	/** 图片加载:成功/失败/未命中缓存计数。 */
	imageLoads: { hit: number; miss: number; error: number };
	/** 动作切换计数(频繁切换=闪烁风险)。 */
	actionSwitches: number;
	/** 动作切换历史(最近 20 次,用于闪烁诊断)。 */
	recentActions: readonly { action: string; atMs: number }[];
	/** 窗口可见性变化计数。 */
	visibilityChanges: number;
	/** 观测启动时间戳(ms)。 */
	startedAtMs: number;
}

type DropReason =
	| "frame-budget-exceeded"
	| "image-load-blocking"
	| "canvas-resize"
	| "first-frame"
	| "tab-inactive"
	| "unknown";

const FRAME_BUDGET_MS = 1000 / 60; // 60fps 目标
const DROP_THRESHOLD_MS = FRAME_BUDGET_MS * 2; // 超过 2 帧预算算掉帧
const RENDER_WINDOW = 60; // 滚动窗口大小
const ACTION_HISTORY_LIMIT = 20;
const REPORT_INTERVAL_MS = 5000; // 每 5 秒汇总报告一次

export class PetRenderObserver {
	private startedAt = performance.now();
	private framesRendered = 0;
	private framesDropped = 0;
	private dropReasons: Record<string, number> = {};
	private renderTimes: number[] = [];
	private frameIntervals: number[] = [];
	private lastFrameAt = 0;
	private imageHits = 0;
	private imageMisses = 0;
	private imageErrors = 0;
	private actionSwitches = 0;
	private recentActions: { action: string; atMs: number }[] = [];
	private lastActionId = "";
	private visibilityChanges = 0;
	private lastReportAt = 0;
	private lastActionSwitchAt = 0;

	/** 渲染帧开始:记录时间戳,检测掉帧。 */
	onFrameStart(now: number): void {
		if (this.lastFrameAt > 0) {
			const interval = now - this.lastFrameAt;
			this.frameIntervals.push(interval);
			if (this.frameIntervals.length > RENDER_WINDOW) this.frameIntervals.shift();

			if (interval > DROP_THRESHOLD_MS) {
				this.framesDropped++;
				const reason = this.classifyDrop(interval, now);
				this.dropReasons[reason] = (this.dropReasons[reason] ?? 0) + 1;
			}
		}
		this.lastFrameAt = now;
	}

	/** 渲染帧结束:记录耗时。 */
	onFrameEnd(now: number, renderStartMs: number): void {
		const elapsed = now - renderStartMs;
		this.renderTimes.push(elapsed);
		if (this.renderTimes.length > RENDER_WINDOW) this.renderTimes.shift();
		this.framesRendered++;

		// 周期性汇总报告
		if (now - this.lastReportAt > REPORT_INTERVAL_MS) {
			this.lastReportAt = now;
			this.report(now);
		}
	}

	/** 图片缓存命中。 */
	onImageHit(): void {
		this.imageHits++;
	}

	/** 图片缓存未命中(需异步加载,可能阻塞渲染)。 */
	onImageMiss(url: string): void {
		this.imageMisses++;
		// 首次加载新图片是掉帧的常见原因
		if (this.lastFrameAt > 0) {
			const reason = "image-load-blocking";
			this.dropReasons[reason] = (this.dropReasons[reason] ?? 0) + 1;
		}
	}

	/** 图片加载失败(404/解码错误)。 */
	onImageError(url: string): void {
		this.imageErrors++;
		console.warn(`[pet-obs] image load failed: ${url.slice(-60)}`);
	}

	/** 动作切换(频繁切换=闪烁)。 */
	onActionSwitch(actionId: string, now: number): void {
		if (actionId === this.lastActionId) return;
		this.actionSwitches++;
		this.recentActions.push({ action: actionId, atMs: now });
		if (this.recentActions.length > ACTION_HISTORY_LIMIT) this.recentActions.shift();

		// 闪烁检测:100ms 内连续切换 3+ 次
		const recent = this.recentActions.filter((a) => now - a.atMs < 100);
		if (recent.length >= 3 && recent[0] !== undefined) {
			console.warn(
				`[pet-obs] FLICKER DETECTED: ${recent.length} action switches in ${Math.round(now - recent[0].atMs)}ms: ${recent.map((a) => a.action).join(" → ")}`,
			);
		}
		this.lastActionId = actionId;
		this.lastActionSwitchAt = now;
	}

	/** 窗口可见性变化。 */
	onVisibilityChange(visible: boolean, now: number): void {
		this.visibilityChanges++;
		console.log(`[pet-obs] visibility: ${visible ? "shown" : "hidden"} at ${Math.round(now - this.startedAt)}ms`);
	}

	/** 获取当前指标快照。 */
	snapshot(): PetRenderMetrics {
		const avg = (arr: number[]): number =>
			arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
		const max = (arr: number[]): number =>
			arr.length > 0 ? Math.max(...arr) : 0;

		return {
			framesRendered: this.framesRendered,
			framesDropped: this.framesDropped,
			dropReasons: { ...this.dropReasons },
			avgRenderMs: Number(avg(this.renderTimes).toFixed(2)),
			maxRenderMs: Number(max(this.renderTimes).toFixed(2)),
			avgFrameIntervalMs: Number(avg(this.frameIntervals).toFixed(2)),
			imageLoads: {
				hit: this.imageHits,
				miss: this.imageMisses,
				error: this.imageErrors,
			},
			actionSwitches: this.actionSwitches,
			recentActions: [...this.recentActions],
			visibilityChanges: this.visibilityChanges,
			startedAtMs: this.startedAt,
		};
	}

	/** 周期性汇总报告(console + data-* 属性)。 */
	private report(now: number): void {
		const snap = this.snapshot();
		const uptime = Math.round((now - this.startedAt) / 1000);
		const fps =
			this.frameIntervals.length > 0
				? Math.round(1000 / (snap.avgFrameIntervalMs || 16.7))
				: 0;
		const dropRate =
			snap.framesRendered > 0
				? ((snap.framesDropped / snap.framesRendered) * 100).toFixed(1)
				: "0";

		const summary =
			`[pet-obs] ${uptime}s | fps=${fps} | drops=${snap.framesDropped}(${dropRate}%) ` +
			`| render=${snap.avgRenderMs}ms(max ${snap.maxRenderMs}) ` +
			`| img(hit=${snap.imageLoads.hit}/miss=${snap.imageLoads.miss}/err=${snap.imageLoads.error}) ` +
			`| switches=${snap.actionSwitches} | vis=${snap.visibilityChanges}`;

		if (snap.framesDropped > 10 || snap.imageLoads.error > 0 || snap.actionSwitches > 50) {
			console.warn(summary, snap.dropReasons);
		} else {
			console.log(summary);
		}

		// 写 data-* 属性供截图/外部工具读取
		this.writeToDom(snap, fps);
	}

	/** 把关键指标写到 DOM 的 data-* 属性上。 */
	private writeToDom(snap: PetRenderMetrics, fps: number): void {
		const canvas = document.querySelector<HTMLCanvasElement>(".pet-stage canvas");
		if (!canvas) return;
		canvas.dataset.obsFps = String(fps);
		canvas.dataset.obsDrops = String(snap.framesDropped);
		canvas.dataset.obsRenderMs = String(snap.avgRenderMs);
		canvas.dataset.obsImgMiss = String(snap.imageLoads.miss);
		canvas.dataset.obsImgErr = String(snap.imageLoads.error);
		canvas.dataset.obsSwitches = String(snap.actionSwitches);
		canvas.dataset.obsModel = this.lastActionId;
	}

	private classifyDrop(interval: number, now: number): DropReason {
		if (this.framesRendered < 5) return "first-frame";
		if (typeof document !== "undefined" && document.hidden) return "tab-inactive";
		// 检查是否是图片首次加载导致
		if (this.imageMisses > 0 && interval > 100) return "image-load-blocking";
		if (interval > 500) return "canvas-resize";
		return "frame-budget-exceeded";
	}
}

/** 全局单例:渲染循环与桥接共用。 */
export const petRenderObserver = new PetRenderObserver();
