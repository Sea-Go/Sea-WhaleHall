/** A privacy-bounded task summary shared between the client, Bun, and pet panel. */
export interface PetTodayTask {
	id: string;
	title: string;
	timeLabel: string;
	state: "proposed" | "committed";
}

export type PetTodaySchedule = {
	status: "loading" | "ready" | "unavailable";
	date: string;
	timeZone: string;
	tasks: readonly PetTodayTask[];
};
