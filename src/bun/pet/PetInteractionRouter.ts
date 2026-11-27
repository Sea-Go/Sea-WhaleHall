/**
 * 桌宠交互路由:把指针/拖拽/窗口事件翻译为状态机事件与宿主保留态
 * 强制(标准 §4 系统不变量)。宿主保留的交互语义,不含形象知识。
 */

import type { PetBehaviorInterpreter } from "./PetBehaviorInterpreter";

export type PetPointerEvent =
	| { kind: "hover" }
	| { kind: "hoverEnd" }
	| { kind: "click"; rapid: boolean }
	| { kind: "pet" }
	| { kind: "poke" }
	| { kind: "dragStart" }
	| { kind: "dragEnd" };

export interface PetInteractionRouterOptions {
	interpreter: PetBehaviorInterpreter;
	/** 播放指令出口(用于点击反馈直派,同名约定)。 */
	onPlay: (command: { actionId: string }) => void;
	log?: (message: string) => void;
}

export class PetInteractionRouter {
	private readonly options: PetInteractionRouterOptions;
	private dragging = false;

	constructor(options: PetInteractionRouterOptions) {
		this.options = options;
	}

	pointer(event: PetPointerEvent): void {
		const { interpreter } = this.options;
		switch (event.kind) {
			case "hover":
				interpreter.dispatch("pointer:hover");
				return;
			case "hoverEnd":
				// 悬停结束无状态机词;由包用 pointer:hover 的目标态自行回转。
				return;
			case "click":
				if (this.dragging) return;
				if (event.rapid) {
					this.options.onPlay({ actionId: "rapidClickAnnoyed" });
					interpreter.dispatch("pointer:click");
					return;
				}
				this.options.onPlay({ actionId: "clickFeedback" });
				interpreter.dispatch("pointer:click");
				return;
			case "pet":
				this.options.onPlay({ actionId: "petHead" });
				interpreter.dispatch("pointer:pet");
				return;
			case "poke":
				this.options.onPlay({ actionId: "pokeFace" });
				interpreter.dispatch("pointer:poke");
				return;
			case "dragStart":
				this.dragging = true;
				interpreter.forceState("dragged");
				return;
			case "dragEnd":
				if (!this.dragging) return;
				this.dragging = false;
				interpreter.forceState("drop");
				return;
		}
	}

	/** 拖放回稳:窗口控制器确认落地后调用。 */
	settleAfterDrop(): void {
		this.options.interpreter.releaseReserved();
	}

	hidden(hidden: boolean): void {
		if (hidden) {
			this.options.interpreter.forceState("hidden");
		} else {
			this.options.interpreter.releaseReserved();
		}
	}

	exit(): void {
		this.options.interpreter.forceState("exit");
	}
}
