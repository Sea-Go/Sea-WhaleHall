import type { PlanningController } from "../features/planning/public";
import type {
	PetPresentationBridge,
	PetPresentationEvent,
} from "../features/pet-bridge/public";

/**
 * App-level coordination keeps planning unaware of the pet WebView while still
 * turning product state changes into optional presentation feedback.
 */
export class PlanningPetCoordinator {
	private stopListening: (() => void) | null = null;
	private previousStatus: ReturnType<PlanningController["getSnapshot"]>["status"];
	private enabled = true;

	constructor(
		private readonly planning: PlanningController,
		private readonly pet: PetPresentationBridge,
	) {
		this.previousStatus = planning.getSnapshot().status;
	}

	start(): void {
		if (this.stopListening) return;
		this.previousStatus = this.planning.getSnapshot().status;
		this.stopListening = this.planning.subscribe(() => this.handleStateChange());
	}

	stop(): void {
		this.stopListening?.();
		this.stopListening = null;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	private handleStateChange(): void {
		const currentStatus = this.planning.getSnapshot().status;
		const previousStatus = this.previousStatus;
		this.previousStatus = currentStatus;
		if (!this.enabled) return;

		if (currentStatus === "generating" && previousStatus !== "generating") {
			this.emit({ kind: "plan-generation-started" });
			return;
		}
		if (currentStatus === "review" && previousStatus === "generating") {
			this.emit({ kind: "plan-generation-succeeded" });
			return;
		}
		if (
			currentStatus === "generation-error" &&
			previousStatus !== "generation-error"
		) {
			this.emit({ kind: "plan-generation-failed" });
		}
	}

	private emit(event: PetPresentationEvent): void {
		void this.pet.present(event).catch(() => {
			// The infrastructure bridge records a sanitized diagnostic. This final
			// guard keeps presentation feedback outside the planning failure path.
		});
	}
}
