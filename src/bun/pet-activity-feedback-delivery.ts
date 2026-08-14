import {
	isPetActivityFeedbackClearResponse,
	isPetActivityFeedbackPresentation,
	isPetActivityFeedbackRendererReady,
	type PetActivityFeedbackClearRequest,
	type PetActivityFeedbackClearResponse,
	type PetActivityFeedbackPresentation,
	type PetActivityFeedbackRendererChallenge,
} from "../shared/pet-activity-feedback";

export interface PetActivityFeedbackDeliveryOptions {
	present: (
		presentation: PetActivityFeedbackPresentation,
	) => unknown | Promise<unknown>;
	clear: (
		request: PetActivityFeedbackClearRequest,
	) =>
		| PetActivityFeedbackClearResponse
		| Promise<PetActivityFeedbackClearResponse>;
	failClosedAfterClearFailure: (input: {
		reloadRequired: boolean;
		rendererEpoch: string;
	}) => unknown | Promise<unknown>;
	createClearId?: () => string;
	createRendererEpoch?: () => string;
	initiallyVisible?: boolean;
}

type RendererAttempt = {
	epoch: string;
	navigationCommitted: boolean;
	documentReady: boolean;
	accepted: boolean;
};

/** Current-process, history-backed best-effort delivery to the pet WebView. */
export class PetActivityFeedbackDelivery {
	private visible: boolean;
	private disposed = false;
	private readonly attemptedPresentationIds = new Set<string>();
	private clearSequence = 0;
	private attempt: RendererAttempt | null = null;

	constructor(private readonly options: PetActivityFeedbackDeliveryOptions) {
		this.visible = options.initiallyVisible ?? true;
	}

	/** Starts one physical renderer load. Repeated calls while pending are idempotent. */
	beginRendererLoad(): string {
		if (this.attempt !== null && !this.attempt.accepted) {
			return this.attempt.epoch;
		}
		const epoch = this.nextRendererEpoch();
		this.attempt = {
			epoch,
			navigationCommitted: false,
			documentReady: false,
			accepted: false,
		};
		return epoch;
	}

	/** Commits the pending physical navigation and invalidates the previous JS document. */
	markRendererNavigationCommitted(): string | null {
		if (this.disposed) return null;
		let attempt = this.attempt;
		if (attempt === null || attempt.accepted) {
			this.beginRendererLoad();
			attempt = this.attempt;
		}
		if (attempt === null) return null;
		// Every native commit is a new JS document, including redirects and HMR.
		// Rotate the proof identity so a response issued by the prior document
		// can never authorize this one.
		attempt.epoch = this.nextRendererEpoch();
		attempt.navigationCommitted = true;
		attempt.documentReady = false;
		return attempt.epoch;
	}

	/** Marks a native document boundary and returns the exact challenge to prove. */
	markRendererDocumentReady(): PetActivityFeedbackRendererChallenge | null {
		if (this.disposed) return null;
		let attempt = this.attempt;
		if (attempt === null || attempt.accepted) {
			this.beginRendererLoad();
			attempt = this.attempt;
		}
		if (attempt === null || !attempt.navigationCommitted) return null;
		attempt.documentReady = true;
		return { rendererEpoch: attempt.epoch };
	}

	/** Returns the challenge only while this exact document is awaiting proof. */
	rendererChallenge(): PetActivityFeedbackRendererChallenge | null {
		const attempt = this.attempt;
		if (
			this.disposed ||
			attempt === null ||
			attempt.accepted ||
			!attempt.navigationCommitted ||
			!attempt.documentReady
		) {
			return null;
		}
		return { rendererEpoch: attempt.epoch };
	}

	markRendererReady(value: unknown): boolean {
		const attempt = this.attempt;
		if (
			this.disposed ||
			attempt === null ||
			attempt.accepted ||
			!attempt.navigationCommitted ||
			!attempt.documentReady ||
			!isPetActivityFeedbackRendererReady(value) ||
			value.rendererEpoch !== attempt.epoch
		) {
			return false;
		}
		attempt.accepted = true;
		return true;
	}

	isRendererAttemptCurrent(rendererEpoch: string): boolean {
		return !this.disposed && this.attempt?.epoch === rendererEpoch;
	}

	markRendererUnavailable(): void {
		if (this.disposed) return;
		if (this.attempt?.accepted === true) {
			this.beginRendererLoad();
		}
	}

	async setVisible(visible: boolean): Promise<void> {
		if (this.disposed || this.visible === visible) return;
		this.visible = visible;
		if (!visible) await this.clearForAccountTransition();
	}

	present(presentation: PetActivityFeedbackPresentation): boolean {
		if (
			this.disposed ||
			!this.visible ||
			this.attempt?.accepted !== true ||
			!isPetActivityFeedbackPresentation(presentation) ||
			this.attemptedPresentationIds.has(presentation.presentationId)
		) {
			return false;
		}
		this.attemptedPresentationIds.add(presentation.presentationId);
		try {
			this.ignoreRejection(this.options.present(presentation));
			return true;
		} catch {
			return false;
		}
	}

	async clearForAccountTransition(): Promise<void> {
		if (this.disposed) return;
		if (this.attempt?.accepted !== true) {
			await this.failClosed(
				new Error(
					"The pet renderer is not ready to acknowledge account cleanup.",
				),
			);
			return;
		}
		const rendererEpoch = this.attempt.epoch;
		const clearId = this.nextClearId();
		try {
			const response = await this.options.clear({ clearId });
			if (!this.isRendererAttemptCurrent(rendererEpoch)) return;
			if (!isPetActivityFeedbackClearResponse(response, clearId)) {
				throw new Error(
					"The pet renderer returned an invalid clear acknowledgement.",
				);
			}
		} catch (error) {
			if (!this.isRendererAttemptCurrent(rendererEpoch)) return;
			await this.failClosed(error, rendererEpoch);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		if (this.attempt?.accepted === true) {
			try {
				this.ignoreRejection(
					this.options.clear({ clearId: this.nextClearId() }),
				);
			} catch {}
		}
		this.disposed = true;
		this.attempt = null;
		this.attemptedPresentationIds.clear();
	}

	private async failClosed(
		clearError: unknown,
		expectedRendererEpoch?: string,
	): Promise<void> {
		if (
			expectedRendererEpoch !== undefined &&
			!this.isRendererAttemptCurrent(expectedRendererEpoch)
		) {
			return;
		}
		const reloadRequired = this.attempt === null || this.attempt.accepted;
		if (reloadRequired) this.beginRendererLoad();
		const rendererEpoch = this.attempt?.epoch;
		if (rendererEpoch === undefined) return;
		try {
			await this.options.failClosedAfterClearFailure({
				reloadRequired,
				rendererEpoch,
			});
		} catch (fallbackError) {
			throw new AggregateError(
				[clearError, fallbackError],
				"The pet renderer could not be cleared or hidden safely.",
			);
		}
	}

	private ignoreRejection(result: unknown | Promise<unknown>): void {
		void Promise.resolve(result).catch(() => undefined);
	}

	private nextClearId(): string {
		return (
			this.options.createClearId?.() ??
			`pet-activity-clear-${Date.now()}-${++this.clearSequence}`
		);
	}

	private nextRendererEpoch(): string {
		return this.options.createRendererEpoch?.() ?? crypto.randomUUID();
	}
}
