import type { PetPresentationEvent } from "../../../../shared/pet-presentation";
import type { PetTodaySchedule } from "../../../../shared/pet-panel";

export interface PetPresentationBridge {
	present(event: PetPresentationEvent): Promise<void>;
	setVisible(visible: boolean): Promise<void>;
	updateTodaySchedule(schedule: PetTodaySchedule): Promise<void>;
}

export interface PetBridgeDiagnosticLogger {
	warn(
		message: string,
		context: {
		operation: "present" | "set-visible" | "update-today-schedule";
			eventKind?: PetPresentationEvent["kind"];
			category: "transport";
		},
	): void;
}
