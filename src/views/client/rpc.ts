import { Electroview } from "electrobun/view";
import type {
	ClientRPC,
	ActiveGoalContextV1,
	LocalMonitoringConfigure,
	LocalRuntimeStatus,
	MonitoringPermissionSettingsTarget,
	PetPresentationEvent,
} from "../../shared/contracts";

type StatusListener = (status: LocalRuntimeStatus) => void;
type VisibilityListener = (visible: boolean) => void;

const statusListeners = new Set<StatusListener>();
const visibilityListeners = new Set<VisibilityListener>();

const rpc = Electroview.defineRPC<ClientRPC>({
	maxRequestTime: 35_000,
	handlers: {
		requests: {},
		messages: {
			localStatusChanged: (status) => {
				for (const listener of statusListeners) listener(status);
			},
			petVisibilityChanged: ({ visible }) => {
				for (const listener of visibilityListeners) listener(visible);
			},
		},
	},
});

new Electroview({ rpc });

export const clientApi = {
	getLocalStatus: () => rpc.request.getLocalStatus({}),
	getMonitoringStatus: () => rpc.request.getMonitoringStatus({}),
	configureMonitoring: (configuration: LocalMonitoringConfigure) =>
		rpc.request.configureMonitoring(configuration),
	pauseMonitoring: () => rpc.request.pauseMonitoring({}),
	resumeMonitoring: () => rpc.request.resumeMonitoring({}),
	refreshMonitoringPermissions: (prompt = false) =>
		rpc.request.refreshMonitoringPermissions({ prompt }),
	openMonitoringPermissionSettings: (
		permission: MonitoringPermissionSettingsTarget,
	) => rpc.request.openMonitoringPermissionSettings({ permission }),
	exportFiveMinuteAuditToFile: (options: {
		fromMs: number;
		includeDecryptedContent: boolean;
	}) => rpc.request.exportFiveMinuteAuditToFile(options),
	startFiveMinuteAuditCapture: () =>
		rpc.request.startFiveMinuteAuditCapture({}),
	getFiveMinuteAuditCaptureStatus: () =>
		rpc.request.getFiveMinuteAuditCaptureStatus({}),
	cancelFiveMinuteAuditCapture: (captureId: string) =>
		rpc.request.cancelFiveMinuteAuditCapture({ captureId }),
	setPetVisible: (visible: boolean) => rpc.request.setPetVisible({ visible }),
	presentPetEvent: (event: PetPresentationEvent) =>
		rpc.request.presentPetEvent(event),
	setActiveGoalContext: (goal: ActiveGoalContextV1 | null) =>
		rpc.request.setActiveGoalContext({ goal }),
	onStatus(listener: StatusListener): () => void {
		statusListeners.add(listener);
		return () => statusListeners.delete(listener);
	},
	onPetVisibility(listener: VisibilityListener): () => void {
		visibilityListeners.add(listener);
		return () => visibilityListeners.delete(listener);
	},
};
