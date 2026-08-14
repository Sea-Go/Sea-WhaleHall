import { Electroview } from "electrobun/view";
import type {
	ClientRPC,
	DataCenterAuthSessionProjection,
	DataCenterSyncStatus,
	LocalMonitoringConfigure,
	LocalRuntimeStatus,
	MonitoringPermissionSettingsTarget,
	PetPresentationEvent,
	PrivateTrainingWindowExportRequest,
	ConfirmPlanRevisionCommand,
	ConfirmPlanningObservationCommand,
	CreatePlanDraftCommand,
	PlanningCalendarMutationProjection,
	PlanningChangeProjection,
	PlanningNotificationProjection,
	PlanningWriteCommand,
	SendPlanMessageCommand,
	SetPlanningTaskStatusCommand,
	UndoPlanningAdjustmentCommand,
} from "../../shared/contracts";

type StatusListener = (status: LocalRuntimeStatus) => void;
type VisibilityListener = (visible: boolean) => void;
type PlanChangeListener = (change: PlanningChangeProjection) => void;
type CalendarChangeListener = (version: number) => void;
type PlanningNotificationListener = (
	notification: PlanningNotificationProjection,
) => void;

const statusListeners = new Set<StatusListener>();
const visibilityListeners = new Set<VisibilityListener>();
const planChangeListeners = new Set<PlanChangeListener>();
const calendarChangeListeners = new Set<CalendarChangeListener>();
const planningNotificationListeners = new Set<PlanningNotificationListener>();

const rpc = Electroview.defineRPC<ClientRPC>({
	// Planning analysis is a bounded local-model request and may include one
	// structured-output repair pass. Match the Bun-side transport budget so the
	// persisted request can finish instead of surfacing a false renderer timeout.
	maxRequestTime: 260_000,
	handlers: {
		requests: {},
		messages: {
			localStatusChanged: (status) => {
				for (const listener of statusListeners) listener(status);
			},
			petVisibilityChanged: ({ visible }) => {
				for (const listener of visibilityListeners) listener(visible);
			},
			planChanged: (change) => {
				for (const listener of planChangeListeners) listener(change);
			},
			calendarChanged: ({ version }) => {
				for (const listener of calendarChangeListeners) listener(version);
			},
			planningNotification: (notification) => {
				for (const listener of planningNotificationListeners) {
					listener(notification);
				}
			},
		},
	},
});

new Electroview({ rpc });

export type {
	DataCenterAuthSessionProjection,
	DataCenterSyncStatus,
} from "../../shared/contracts";

export const clientApi = {
	listPlans: () => rpc.request.listPlans({}),
	getPlan: (planId: string) => rpc.request.getPlan({ planId }),
	createPlanDraft: (command: CreatePlanDraftCommand) =>
		rpc.request.createPlanDraft(command),
	sendPlanMessage: (command: SendPlanMessageCommand) =>
		rpc.request.sendPlanMessage(command),
	confirmPlanRevision: (command: ConfirmPlanRevisionCommand) =>
		rpc.request.confirmPlanRevision(command),
	setPlanningTaskStatus: (command: SetPlanningTaskStatusCommand) =>
		rpc.request.setPlanningTaskStatus(command),
	confirmPlanningObservation: (command: ConfirmPlanningObservationCommand) =>
		rpc.request.confirmPlanningObservation(command),
	pausePlan: (command: PlanningWriteCommand) => rpc.request.pausePlan(command),
	resumePlan: (command: PlanningWriteCommand) => rpc.request.resumePlan(command),
	completePlan: (command: PlanningWriteCommand) =>
		rpc.request.completePlan(command),
	archivePlan: (command: PlanningWriteCommand) =>
		rpc.request.archivePlan(command),
	undoPlanAdjustment: (command: UndoPlanningAdjustmentCommand) =>
		rpc.request.undoPlanAdjustment(command),
	retryPendingPlanAnalysis: (command: PlanningWriteCommand) =>
		rpc.request.retryPendingPlanAnalysis(command),
	loadPlanningCalendar: () => rpc.request.loadPlanningCalendar({}),
	mutatePlanningCalendar: (mutation: PlanningCalendarMutationProjection) =>
		rpc.request.mutatePlanningCalendar(mutation),
	mutatePlanningCalendarBatch: (
		batchId: string,
		mutations: PlanningCalendarMutationProjection[],
	) => rpc.request.mutatePlanningCalendarBatch({ batchId, mutations }),
	getLocalStatus: () => rpc.request.getLocalStatus({}),
	getMonitoringStatus: () => rpc.request.getMonitoringStatus({}),
	configureMonitoring: (configuration: LocalMonitoringConfigure) =>
		rpc.request.configureMonitoring(configuration),
	pauseMonitoring: () => rpc.request.pauseMonitoring({}),
	resumeMonitoring: () => rpc.request.resumeMonitoring({}),
	refreshMonitoringPermissions: () =>
		rpc.request.refreshMonitoringPermissions({}),
	setupMonitoringPermissions: () =>
		rpc.request.setupMonitoringPermissions({}),
	openMonitoringPermissionSettings: (
		permission: MonitoringPermissionSettingsTarget,
	) => rpc.request.openMonitoringPermissionSettings({ permission }),
	getContentVaultStatus: () => rpc.request.getContentVaultStatus({}),
	migrateLegacyContentVault: () => rpc.request.migrateLegacyContentVault({}),
	exportFiveMinuteAuditToFile: (options: {
		fromMs: number;
		includeDecryptedContent: boolean;
	}) => rpc.request.exportFiveMinuteAuditToFile(options),
	exportPrivateTrainingWindows: (
		request: PrivateTrainingWindowExportRequest,
	) => rpc.request.exportPrivateTrainingWindows(request),
	getPrivateTrainingWindowExportStatus: () =>
		rpc.request.getPrivateTrainingWindowExportStatus({}),
	startFiveMinuteAuditCapture: () =>
		rpc.request.startFiveMinuteAuditCapture({}),
	getFiveMinuteAuditCaptureStatus: () =>
		rpc.request.getFiveMinuteAuditCaptureStatus({}),
	cancelFiveMinuteAuditCapture: (captureId: string) =>
		rpc.request.cancelFiveMinuteAuditCapture({ captureId }),
	setPetVisible: (visible: boolean) => rpc.request.setPetVisible({ visible }),
	presentPetEvent: (event: PetPresentationEvent) =>
		rpc.request.presentPetEvent(event),
	datacenterSignIn: (credentials: { email: string; password: string }) =>
		rpc.request.datacenterSignIn(credentials),
	datacenterSignOut: () => rpc.request.datacenterSignOut({}),
	datacenterRestoreSession: () => rpc.request.datacenterRestoreSession({}),
	datacenterSyncStatus: () => rpc.request.datacenterSyncStatus({}),
	datacenterSetSyncEnabled: (enabled: boolean) =>
		rpc.request.datacenterSetSyncEnabled({ enabled }),
	datacenterRefreshConsents: () => rpc.request.datacenterRefreshConsents({}),
	onStatus(listener: StatusListener): () => void {
		statusListeners.add(listener);
		return () => statusListeners.delete(listener);
	},
	onPetVisibility(listener: VisibilityListener): () => void {
		visibilityListeners.add(listener);
		return () => visibilityListeners.delete(listener);
	},
	onPlanChanged(listener: PlanChangeListener): () => void {
		planChangeListeners.add(listener);
		return () => planChangeListeners.delete(listener);
	},
	onCalendarChanged(listener: CalendarChangeListener): () => void {
		calendarChangeListeners.add(listener);
		return () => calendarChangeListeners.delete(listener);
	},
	onPlanningNotification(listener: PlanningNotificationListener): () => void {
		planningNotificationListeners.add(listener);
		return () => planningNotificationListeners.delete(listener);
	},
};
