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
	private previousState: ReturnType<PlanningController["getSnapshot"]>;
	private enabled = true;
	private analysisInFlight = false;

	constructor(
		private readonly planning: PlanningController,
		private readonly pet: PetPresentationBridge,
	) {
		this.previousState = planning.getSnapshot();
	}

	start(): void {
		if (this.stopListening) return;
		this.previousState = this.planning.getSnapshot();
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
		const current = this.planning.getSnapshot();
		const previous = this.previousState;
		this.previousState = current;
		if (!this.enabled) return;

		if (isPlanningAnalysisPending(current) && !isPlanningAnalysisPending(previous)) {
			this.analysisInFlight = true;
			this.emit({ kind: "plan-generation-started" });
			return;
		}
		if (
			(current.status === "awaiting-confirmation" || current.status === "draft") &&
			this.analysisInFlight
		) {
			this.analysisInFlight = false;
			this.emit({ kind: "plan-generation-succeeded" });
			return;
		}
		if (
			this.analysisInFlight &&
			(current.status === "model-unavailable" || current.status === "error") &&
			current.status !== previous.status
		) {
			this.analysisInFlight = false;
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

function isPlanningAnalysisPending(
	state: ReturnType<PlanningController["getSnapshot"]>,
): boolean {
	return (
		state.status === "creating" ||
		(state.status === "updating" &&
			(state.operation === "send-message" ||
				state.operation === "retry-analysis"))
	);
}
