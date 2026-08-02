import type {
	EvidenceFactV2,
	SemanticEventV2,
	TimelineSummaryV2,
} from "./types";

export type TrainingDatasetEnvelopeV2 = {
	schemaVersion: "training-dataset-envelope.v2";
	timeline: TimelineSummaryV2;
	semanticEvents: SemanticEventV2[];
	evidenceFacts: EvidenceFactV2[];
};

/**
 * Future encrypted dataset export boundary. Implementations are intentionally
 * absent in v2 phase one: no network or home-cloud upload is authorized.
 */
export interface TrainingDatasetSink {
	readonly enabled: boolean;
	emit(envelope: TrainingDatasetEnvelopeV2): Promise<void>;
}

export class DisabledTrainingDatasetSink implements TrainingDatasetSink {
	readonly enabled = false;

	async emit(_envelope: TrainingDatasetEnvelopeV2): Promise<void> {
		// Deliberate no-op. A future adapter must be enabled explicitly and
		// implement authenticated encrypted transport outside this module.
	}
}
