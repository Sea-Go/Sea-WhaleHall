import type { PetInteractionMessage } from "../shared/contracts";

type SurfaceTimer = ReturnType<typeof setTimeout>;

export interface PetSurfaceRouterOptions {
	singleClickDelayMs?: number;
	schedule?: (callback: () => void, delayMs: number) => SurfaceTimer;
	cancel?: (timer: SurfaceTimer) => void;
	onOpenPanel: () => void;
	onOpenMain: () => void;
}

/** Routes existing click semantics without changing the pet interaction FSM. */
export class PetSurfaceRouter {
	private readonly singleClickDelayMs: number;
	private readonly schedule: (callback: () => void, delayMs: number) => SurfaceTimer;
	private readonly cancel: (timer: SurfaceTimer) => void;
	private singleClickTimer: SurfaceTimer | null = null;

	constructor(private readonly options: PetSurfaceRouterOptions) {
		this.singleClickDelayMs = Math.max(0, options.singleClickDelayMs ?? 340);
		this.schedule = options.schedule ?? setTimeout;
		this.cancel = options.cancel ?? clearTimeout;
	}

	handle(event: PetInteractionMessage): void {
		if (event.kind === "click") {
			this.clearPendingClick();
			this.singleClickTimer = this.schedule(() => {
				this.singleClickTimer = null;
				this.options.onOpenPanel();
			}, this.singleClickDelayMs);
			return;
		}
		if (event.kind === "doubleClick") {
			this.clearPendingClick();
			this.options.onOpenMain();
			return;
		}
		if (event.kind === "rapidClick" || event.kind === "dragStart") this.clearPendingClick();
	}

	dispose(): void {
		this.clearPendingClick();
	}

	private clearPendingClick(): void {
		if (this.singleClickTimer === null) return;
		this.cancel(this.singleClickTimer);
		this.singleClickTimer = null;
	}
}
