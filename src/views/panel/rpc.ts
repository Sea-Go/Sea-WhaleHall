import { Electroview } from "electrobun/view";
import type { PetPanelRPC, PetTodaySchedule } from "../../shared/contracts";

type ScheduleListener = (schedule: PetTodaySchedule) => void;
const scheduleListeners = new Set<ScheduleListener>();

const rpc = Electroview.defineRPC<PetPanelRPC>({
	maxRequestTime: 5_000,
	handlers: {
		requests: {},
		messages: {
			todayScheduleChanged: (schedule) => {
				for (const listener of scheduleListeners) listener(schedule);
			},
		},
	},
});

new Electroview({ rpc });

export const panelApi = {
	getTodaySchedule: () => rpc.request.getTodaySchedule({}),
	close: () => rpc.request.closePetPanel({}),
	openMain: () => rpc.request.openMainWindow({}),
	onTodaySchedule(listener: ScheduleListener): () => void {
		scheduleListeners.add(listener);
		return () => scheduleListeners.delete(listener);
	},
};
