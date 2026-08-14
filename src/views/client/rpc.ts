import { Electroview } from "electrobun/view";
import type { AppUpdateSnapshot } from "../../shared/app-update";
import type { AuthCredentials } from "../../shared/auth";
import type {
	ActiveGoalContextV1,
	AgentRunEventEnvelope,
	CalendarMutation,
	CancelAgentRunRequest,
	ClientRPC,
	CommitPlanningDraftRequest,
	ConfirmPlanningObservationCommand,
	ConfirmPlanRevisionCommand,
	CreatePlanDraftCommand,
	DecideAgentToolApprovalRequest,
	GetAgentRunSnapshotRequest,
	ListProactiveFeedbackRequest,
	ListRestorableAgentRunsRequest,
	LocalMonitoringConfigure,
	LocalRuntimeStatus,
	MonitoringPermissionSettingsTarget,
	PetPresentationEvent,
	PlanningCalendarMutationProjection,
	PlanningChangeProjection,
	PlanningWriteCommand,
	PrivateTrainingWindowExportRequest,
	ProactiveFeedbackAvailable,
	SavePlanningDraftRequest,
	SendPlanMessageCommand,
	SetAgentReadPermissionsRequest,
	SetPlanningTaskStatusCommand,
	SetProactiveFeedbackPolicyRequest,
	StartConversationTurnRequest,
	StartTaskPlanningRunRequest,
	SubmitPlanningClarificationRequest,
	UndoPlanningAdjustmentCommand,
} from "../../shared/contracts";

type StatusListener = (status: LocalRuntimeStatus) => void;
type VisibilityListener = (visible: boolean) => void;
type AgentRunEventListener = (event: AgentRunEventEnvelope) => void;
type AuthSessionExpiredListener = () => void;
type ProactiveFeedbackAvailableListener = (
	event: ProactiveFeedbackAvailable,
) => void;
type AppUpdateStatusListener = (snapshot: AppUpdateSnapshot) => void;
type PlanChangeListener = (change: PlanningChangeProjection) => void;
type CalendarChangeListener = (version: number) => void;

const statusListeners = new Set<StatusListener>();
const visibilityListeners = new Set<VisibilityListener>();
const agentRunEventListeners = new Set<AgentRunEventListener>();
const authSessionExpiredListeners = new Set<AuthSessionExpiredListener>();
const proactiveFeedbackAvailableListeners =
	new Set<ProactiveFeedbackAvailableListener>();
const appUpdateStatusListeners = new Set<AppUpdateStatusListener>();
const planChangeListeners = new Set<PlanChangeListener>();
const calendarChangeListeners = new Set<CalendarChangeListener>();

const rpc = Electroview.defineRPC<ClientRPC>({
	// Planning analysis is a bounded local-model request and may include one
	// structured-output repair pass. Match the Bun-side transport budget so the
	// persisted request can finish instead of surfacing a false renderer timeout.
	maxRequestTime: 260_000,
	handlers: {
		requests: {},
		messages: {
			appUpdateStatusChanged: (snapshot) => {
				for (const listener of appUpdateStatusListeners) listener(snapshot);
			},
			proactiveFeedbackAvailable: (event) => {
				for (const listener of proactiveFeedbackAvailableListeners) {
					listener(event);
				}
			},
			agentRunEvent: (event) => {
				for (const listener of agentRunEventListeners) listener(event);
			},
			authSessionExpired: () => {
				for (const listener of authSessionExpiredListeners) listener();
			},
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
		},
	},
});

new Electroview({ rpc });

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
	resumePlan: (command: PlanningWriteCommand) =>
		rpc.request.resumePlan(command),
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
	getAppUpdateStatus: () => rpc.request.getAppUpdateStatus({}),
	checkForAppUpdate: () => rpc.request.checkForAppUpdate({}),
	downloadAppUpdate: () => rpc.request.downloadAppUpdate({}),
	installAppUpdateAndRestart: () => rpc.request.installAppUpdateAndRestart({}),
	getProactiveFeedbackPolicy: () => rpc.request.getProactiveFeedbackPolicy({}),
	setProactiveFeedbackPolicy: (input: SetProactiveFeedbackPolicyRequest) =>
		rpc.request.setProactiveFeedbackPolicy(input),
	listProactiveFeedback: (input: ListProactiveFeedbackRequest = {}) =>
		rpc.request.listProactiveFeedback(input),
	clearProactiveFeedbackData: () => rpc.request.clearProactiveFeedbackData({}),
	getAgentReadPermissions: () => rpc.request.getAgentReadPermissions({}),
	setAgentReadPermissions: (input: SetAgentReadPermissionsRequest) =>
		rpc.request.setAgentReadPermissions(input),
	restoreAuthSession: () => rpc.request.restoreAuthSession({}),
	signIn: (credentials: AuthCredentials) => rpc.request.signIn(credentials),
	signOut: () => rpc.request.signOut({}),
	loadCalendar: () => rpc.request.loadCalendar({}),
	mutateCalendar: (mutation: CalendarMutation) =>
		rpc.request.mutateCalendar(mutation),
	mutateCalendarBatch: (input: {
		batchId: string;
		mutations: readonly CalendarMutation[];
		expectedRevision?: number;
	}) => rpc.request.mutateCalendarBatch(input),
	getLocalStatus: () => rpc.request.getLocalStatus({}),
	getMonitoringStatus: () => rpc.request.getMonitoringStatus({}),
	configureMonitoring: (configuration: LocalMonitoringConfigure) =>
		rpc.request.configureMonitoring(configuration),
	pauseMonitoring: () => rpc.request.pauseMonitoring({}),
	resumeMonitoring: () => rpc.request.resumeMonitoring({}),
	refreshMonitoringPermissions: () =>
		rpc.request.refreshMonitoringPermissions({}),
	setupMonitoringPermissions: () => rpc.request.setupMonitoringPermissions({}),
	openMonitoringPermissionSettings: (
		permission: MonitoringPermissionSettingsTarget,
	) => rpc.request.openMonitoringPermissionSettings({ permission }),
	getContentVaultStatus: () => rpc.request.getContentVaultStatus({}),
	migrateLegacyContentVault: () => rpc.request.migrateLegacyContentVault({}),
	exportFiveMinuteAuditToFile: (options: {
		fromMs: number;
		includeDecryptedContent: boolean;
	}) => rpc.request.exportFiveMinuteAuditToFile(options),
	exportPrivateTrainingWindows: (request: PrivateTrainingWindowExportRequest) =>
		rpc.request.exportPrivateTrainingWindows(request),
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
	setActiveGoalContext: (goal: ActiveGoalContextV1 | null) =>
		rpc.request.setActiveGoalContext({ goal }),
	startConversationTurn: (input: StartConversationTurnRequest) =>
		rpc.request.startConversationTurn(input),
	startTaskPlanningRun: (input: StartTaskPlanningRunRequest) =>
		rpc.request.startTaskPlanningRun(input),
	submitPlanningClarification: (input: SubmitPlanningClarificationRequest) =>
		rpc.request.submitPlanningClarification(input),
	decideAgentToolApproval: (input: DecideAgentToolApprovalRequest) =>
		rpc.request.decideAgentToolApproval(input),
	cancelAgentRun: (input: CancelAgentRunRequest) =>
		rpc.request.cancelAgentRun(input),
	getAgentRunSnapshot: (input: GetAgentRunSnapshotRequest) =>
		rpc.request.getAgentRunSnapshot(input),
	listRestorableAgentRuns: (input: ListRestorableAgentRunsRequest = {}) =>
		rpc.request.listRestorableAgentRuns(input),
	getActiveConversation: () => rpc.request.getActiveConversation({}),
	loadPlanningAuthority: () => rpc.request.loadPlanningAuthority({}),
	savePlanningDraft: (input: SavePlanningDraftRequest) =>
		rpc.request.savePlanningDraft(input),
	commitPlanningDraft: (input: CommitPlanningDraftRequest) =>
		rpc.request.commitPlanningDraft(input),
	onStatus(listener: StatusListener): () => void {
		statusListeners.add(listener);
		return () => statusListeners.delete(listener);
	},
	onPetVisibility(listener: VisibilityListener): () => void {
		visibilityListeners.add(listener);
		return () => visibilityListeners.delete(listener);
	},
	onAgentRunEvent(listener: AgentRunEventListener): () => void {
		agentRunEventListeners.add(listener);
		return () => agentRunEventListeners.delete(listener);
	},
	onAuthSessionExpired(listener: AuthSessionExpiredListener): () => void {
		authSessionExpiredListeners.add(listener);
		return () => authSessionExpiredListeners.delete(listener);
	},
	onProactiveFeedbackAvailable(
		listener: ProactiveFeedbackAvailableListener,
	): () => void {
		proactiveFeedbackAvailableListeners.add(listener);
		return () => proactiveFeedbackAvailableListeners.delete(listener);
	},
	onAppUpdateStatus(listener: AppUpdateStatusListener): () => void {
		appUpdateStatusListeners.add(listener);
		return () => appUpdateStatusListeners.delete(listener);
	},
	onPlanChanged(listener: PlanChangeListener): () => void {
		planChangeListeners.add(listener);
		return () => planChangeListeners.delete(listener);
	},
	onCalendarChanged(listener: CalendarChangeListener): () => void {
		calendarChangeListeners.add(listener);
		return () => calendarChangeListeners.delete(listener);
	},
};
