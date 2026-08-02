import type { PetPresentationEvent } from "../../../../shared/pet-presentation";

export interface PetPresentationBridge {
	present(event: PetPresentationEvent): Promise<void>;
	setVisible(visible: boolean): Promise<void>;
}

export interface PetBridgeDiagnosticLogger {
	warn(
		message: string,
		context: {
			operation: "present" | "set-visible";
			eventKind?: PetPresentationEvent["kind"];
			category: "transport";
		},
	): void;
}
