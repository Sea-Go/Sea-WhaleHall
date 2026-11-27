import type { PetPresentationEvent } from "../../../../shared/pet-presentation";

export interface PetPresentationBridge {
	present(event: PetPresentationEvent): Promise<void>;
	setVisible(visible: boolean): Promise<void>;
	setModel(modelId: string): Promise<void>;
}

export interface PetBridgeDiagnosticLogger {
	warn(
		message: string,
		context: {
			operation: "present" | "set-visible" | "set-model";
			eventKind?: PetPresentationEvent["kind"];
			category: "transport";
		},
	): void;
}
