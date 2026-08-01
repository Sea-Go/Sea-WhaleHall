import { Electroview } from "electrobun/view";
import type {
	ClientRPC,
	ActiveGoalContextV1,
	AgentRunEventEnvelope,
	CalendarMutation,
	CancelAgentRunRequest,
	CommitPlanningDraftRequest,
	DecideAgentToolApprovalRequest,
	GetAgentRunSnapshotRequest,
	ListRestorableAgentRunsRequest,
	LocalMonitoringConfigure,
	LocalRuntimeStatus,
	MonitoringPermissionSettingsTarget,
	PetPresentationEvent,
	PrivateTrainingWindowExportRequest,
	SavePlanningDraftRequest,
	SetAgentReadPermissionsRequest,
	StartConversationTurnRequest,
	StartTaskPlanningRunRequest,
	SubmitPlanningClarificationRequest,
} from "../../shared/contracts";
import type { AuthCredentials } from "../../shared/auth";

type StatusListener = (status: LocalRuntimeStatus) => void;
type VisibilityListener = (visible: boolean) => void;
type AgentRunEventListener = (event: AgentRunEventEnvelope) => void;
type AuthSessionExpiredListener = () => void;

const statusListeners = new Set<StatusListener>();
const visibilityListeners = new Set<VisibilityListener>();
const agentRunEventListeners = new Set<AgentRunEventListener>();
const authSessionExpiredListeners = new Set<AuthSessionExpiredListener>();

const rpc = Electroview.defineRPC<ClientRPC>({
	maxRequestTime: 35_000,
	handlers: {
		requests: {},
		messages: {
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
		},
	},
});

new Electroview({ rpc });

export const clientApi = {
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
};
