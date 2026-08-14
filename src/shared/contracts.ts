import type { RPCSchema } from "electrobun/bun";
import type {
	LocalMonitoringConfigure,
	LocalMonitoringPermissionCheckState,
	LocalMonitoringPermissionState,
	LocalMonitoringStatus,
	LocalRuntimeStatus,
	LocalVaultKeyStatus,
	LocalVaultLegacyMigrationResult,
} from "../agent/local-protocol";
import type {
	AgentReadPermissionsRpcResult,
	AgentReadPermissionsSnapshot,
	SetAgentReadPermissionsRequest,
} from "./agent-permissions";
import type {
	AgentRunAccepted,
	AgentRunCommandAccepted,
	AgentRunEventEnvelope,
	AgentRunRestorableSummary,
	AgentRunRpcResult,
	AgentRunSnapshot,
	CancelAgentRunRequest,
	DecideAgentToolApprovalRequest,
	GetAgentRunSnapshotRequest,
	ListRestorableAgentRunsRequest,
	StartConversationTurnRequest,
	StartTaskPlanningRunRequest,
	SubmitPlanningClarificationRequest,
} from "./agent-runs";
import type { AppUpdateSnapshot } from "./app-update";
import type { AuthCredentials, AuthRpcResult, AuthSession } from "./auth";
import type {
	CalendarBatchMutationResult,
	CalendarLoadResponse,
	CalendarMutation,
	CalendarMutationResult,
} from "./calendar";
import type {
	ConversationRpcResult,
	ConversationRpcSendResult,
	ConversationRpcThread,
} from "./conversation";
import type { ActiveGoalContextV1 } from "./goal-context";
import type { PetActionId } from "./pet-actions";
import type { PetPresentationEvent } from "./pet-presentation";
import type {
	CommitPlanningDraftRequest,
	PlanningAuthorityRpcResult,
	PlanningAuthoritySnapshot,
	PlanningCommitResult,
	SavePlanningDraftRequest,
} from "./planning-authority";
import type {
	ClearProactiveFeedbackResult,
	ListProactiveFeedbackRequest,
	ProactiveFeedbackAvailable,
	ProactiveFeedbackPage,
	ProactiveFeedbackPolicySnapshot,
	ProactiveFeedbackRpcResult,
	SetProactiveFeedbackPolicyRequest,
} from "./proactive-feedback";
import type {
	TaskPlanningAnswer,
	TaskPlanningInput,
	TaskPlanningRpcResult,
	TaskPlanningSession,
} from "./task-planning";
import type {
	ConfirmPlanRevisionCommand,
	ConfirmPlanningObservationCommand,
	CreatePlanDraftCommand,
	PlanningCalendarBatchResultProjection,
	PlanningCalendarMutationProjection,
	PlanningCalendarMutationResultProjection,
	PlanningChangeProjection,
	PlanningNotificationProjection,
	PlanningPlanProjection,
	PlanningPlanSummaryProjection,
	PlanningWriteCommand,
	SendPlanMessageCommand,
	SetPlanningTaskStatusCommand,
	UndoPlanningAdjustmentCommand,
} from "./planning";

export type {
	ActiveGoalContextV1,
	AgentReadPermissionsRpcResult,
	AgentReadPermissionsSnapshot,
	AgentRunAccepted,
	AgentRunCommandAccepted,
	AgentRunEventEnvelope,
	AgentRunRestorableSummary,
	AgentRunRpcResult,
	AgentRunSnapshot,
	AuthRpcResult,
	AuthSession,
	CalendarBatchMutationResult,
	CalendarLoadResponse,
	CalendarMutation,
	CalendarMutationResult,
	CancelAgentRunRequest,
	ClearProactiveFeedbackResult,
	CommitPlanningDraftRequest,
	ConversationRpcResult,
	ConversationRpcSendResult,
	ConversationRpcThread,
	DecideAgentToolApprovalRequest,
	GetAgentRunSnapshotRequest,
	ListProactiveFeedbackRequest,
	ListRestorableAgentRunsRequest,
	LocalMonitoringConfigure,
	LocalMonitoringPermissionCheckState,
	LocalMonitoringPermissionState,
	LocalMonitoringStatus,
	LocalRuntimeStatus,
	LocalVaultKeyStatus,
	LocalVaultLegacyMigrationResult,
	PetPresentationEvent,
	PlanningAuthorityRpcResult,
	PlanningAuthoritySnapshot,
	PlanningCommitResult,
	ProactiveFeedbackAvailable,
	ProactiveFeedbackPage,
	ProactiveFeedbackPolicySnapshot,
	ProactiveFeedbackRpcResult,
	SavePlanningDraftRequest,
	SetAgentReadPermissionsRequest,
	SetProactiveFeedbackPolicyRequest,
	StartConversationTurnRequest,
	StartTaskPlanningRunRequest,
	SubmitPlanningClarificationRequest,
	TaskPlanningAnswer,
	TaskPlanningInput,
	TaskPlanningRpcResult,
	TaskPlanningSession,
	ConfirmPlanRevisionCommand,
	ConfirmPlanningObservationCommand,
	CreatePlanDraftCommand,
	PlanningCalendarBatchResultProjection,
	PlanningCalendarMutationProjection,
	PlanningCalendarMutationResultProjection,
	PlanningChangeProjection,
	PlanningNotificationProjection,
	PlanningPlanProjection,
	PlanningPlanSummaryProjection,
	PlanningWriteCommand,
	SendPlanMessageCommand,
	SetPlanningTaskStatusCommand,
	UndoPlanningAdjustmentCommand,
};

export type PetMood = "idle" | "happy" | "busy" | "error";

/** Canonical, model-independent action identifier shared by every pet surface. */
export type PetAnimationId = PetActionId;

export type PetState = {
	mood: PetMood;
	message: string;
	action?: PetAnimationId;
	/** Registry id resolved by the renderer; unknown ids safely fall back to whale. */
	modelId?: string;
	environment?: {
		weather?: "clear" | "cloudy" | "rain" | "snow";
		temperatureC?: number;
		holiday?: string;
		/** Local calendar day in MM-DD form. */
		birthday?: string;
	};
	/** @deprecated Use action. Kept while older renderer/backend callers migrate. */
	animation?: PetAnimationId;
};

export type PetInteractionMessage = {
	kind:
		| "hover"
		| "hoverEnd"
		| "click"
		| "doubleClick"
		| "rapidClick"
		| "pet"
		| "petEnd"
		| "poke"
		| "dragStart"
		| "dragEnd";
	action: PetAnimationId;
	modelId: string;
	zone?: "head" | "face" | "body" | "tail" | "limb" | null;
	pointerId?: number;
	dragDelta?: { x: number; y: number };
};

export type NativePetDragState = {
	dragging: boolean;
	reason?: "pointerup" | "webview" | "hidden" | "disposed";
};

export type FiveMinuteAuditFileExportRequest = {
	/** Start of the fixed five-minute range, expressed as Unix epoch milliseconds. */
	fromMs: number;
	/**
	 * False by default. True requires a separate native confirmation before the
	 * native directory chooser is shown.
	 */
	includeDecryptedContent: boolean;
};

/**
 * The renderer intentionally receives no audit contents and no selected path.
 * A basename is returned only after a new mode-0600 file has been completed.
 */
export type FiveMinuteAuditFileExportResult = {
	status: "exported" | "cancelled" | "invalid_range" | "not_ready" | "failed";
	basename: string | null;
};

export type PrivateTrainingWindowExportScope =
	| "latest_committed"
	| "last_24_hours"
	| "all_committed";

export type PrivateTrainingWindowExportRequest = {
	/** Bun resolves immutable COMMITTED window ids for this renderer-safe scope. */
	scope: PrivateTrainingWindowExportScope;
};

export type PrivateTrainingWindowExportStatus = {
	state:
		| "idle"
		| "preparing"
		| "awaiting_confirmation"
		| "choosing_directory"
		| "exporting"
		| "exported"
		| "cancelled"
		| "failed";
	jobId: string | null;
	scope: PrivateTrainingWindowExportScope | null;
	windowCount: number;
	completedWindowCount: number;
	/** Directory basename only; the selected absolute path remains native-only. */
	basename: string | null;
	failureCode:
		| "invalid_request"
		| "not_ready"
		| "no_committed_windows"
		| "too_many_windows"
		| "invalid_destination"
		| "export_failed"
		| null;
	updatedAtMs: number | null;
};

export type FiveMinuteAuditCaptureState =
	| "collecting"
	| "settling"
	| "ready"
	| "failed"
	| "cancelled";

export type FiveMinuteAuditCaptureFailureCode =
	| "authoritative_coverage_timeout"
	| "timeline_job_terminal_failure"
	| "timeline_result_inconsistent";

/**
 * Content-free renderer projection of a local five-minute capture session.
 * A ready capture has proved that every effective semantic event in the exact
 * range is covered by a COMMITTED production Timeline result, or that the
 * exact range contains no effective events. Audit-only projections never
 * satisfy this authority state.
 */
export type FiveMinuteAuditCaptureStatus = {
	captureId: string;
	state: FiveMinuteAuditCaptureState;
	fromMs: number;
	toMs: number;
	updatedAtMs: number;
	analysisCompleteness: "natural_windows_only";
	authoritativeCoverage: "pending" | "complete" | "unavailable";
	failureCode: FiveMinuteAuditCaptureFailureCode | null;
};

export type MonitoringPermissionSettingsTarget =
	| "accessibility"
	| "screenRecording"
	| "inputMonitoring"
	| "browserAutomation";

export type ClientRPC = {
	bun: RPCSchema<{
		requests: {
			listPlans: {
				params: Record<string, never>;
				response: { plans: PlanningPlanSummaryProjection[] };
			};
			getPlan: {
				params: { planId: string };
				response: { plan: PlanningPlanProjection };
			};
			createPlanDraft: {
				params: CreatePlanDraftCommand;
				response: { planId: string };
			};
			sendPlanMessage: {
				params: SendPlanMessageCommand;
				response: { plan: PlanningPlanProjection };
			};
			confirmPlanRevision: {
				params: ConfirmPlanRevisionCommand;
				response: { plan: PlanningPlanProjection };
			};
			setPlanningTaskStatus: {
				params: SetPlanningTaskStatusCommand;
				response: { plan: PlanningPlanProjection };
			};
			confirmPlanningObservation: {
				params: ConfirmPlanningObservationCommand;
				response: { plan: PlanningPlanProjection };
			};
			pausePlan: {
				params: PlanningWriteCommand;
				response: { plan: PlanningPlanProjection };
			};
			resumePlan: {
				params: PlanningWriteCommand;
				response: { plan: PlanningPlanProjection };
			};
			completePlan: {
				params: PlanningWriteCommand;
				response: { plan: PlanningPlanProjection };
			};
			archivePlan: {
				params: PlanningWriteCommand;
				response: { plan: PlanningPlanProjection };
			};
			undoPlanAdjustment: {
				params: UndoPlanningAdjustmentCommand;
				response: { plan: PlanningPlanProjection };
			};
			retryPendingPlanAnalysis: {
				params: PlanningWriteCommand;
				response: { plan: PlanningPlanProjection };
			};
			loadPlanningCalendar: {
				params: Record<string, never>;
				response: {
					events: import('./planning').PlanningCalendarEventProjection[];
					timeZone: string;
				};
			};
			mutatePlanningCalendar: {
				params: PlanningCalendarMutationProjection;
				response: PlanningCalendarMutationResultProjection;
			};
			mutatePlanningCalendarBatch: {
				params: {
					batchId: string;
					mutations: PlanningCalendarMutationProjection[];
				};
				response: PlanningCalendarBatchResultProjection;
			};
			getAppUpdateStatus: {
				params: Record<string, never>;
				response: AppUpdateSnapshot;
			};
			checkForAppUpdate: {
				params: Record<string, never>;
				response: AppUpdateSnapshot;
			};
			downloadAppUpdate: {
				params: Record<string, never>;
				response: AppUpdateSnapshot;
			};
			installAppUpdateAndRestart: {
				params: Record<string, never>;
				response: AppUpdateSnapshot;
			};
			getProactiveFeedbackPolicy: {
				params: Record<string, never>;
				response: ProactiveFeedbackRpcResult<ProactiveFeedbackPolicySnapshot>;
			};
			setProactiveFeedbackPolicy: {
				params: SetProactiveFeedbackPolicyRequest;
				response: ProactiveFeedbackRpcResult<ProactiveFeedbackPolicySnapshot>;
			};
			listProactiveFeedback: {
				params: ListProactiveFeedbackRequest;
				response: ProactiveFeedbackRpcResult<ProactiveFeedbackPage>;
			};
			clearProactiveFeedbackData: {
				params: Record<string, never>;
				response: ProactiveFeedbackRpcResult<ClearProactiveFeedbackResult>;
			};
			getAgentReadPermissions: {
				params: Record<string, never>;
				response: AgentReadPermissionsRpcResult<AgentReadPermissionsSnapshot>;
			};
			setAgentReadPermissions: {
				params: SetAgentReadPermissionsRequest;
				response: AgentReadPermissionsRpcResult<AgentReadPermissionsSnapshot>;
			};
			restoreAuthSession: {
				params: Record<string, never>;
				response: AuthRpcResult<AuthSession | null>;
			};
			signIn: {
				params: AuthCredentials;
				response: AuthRpcResult<AuthSession>;
			};
			signOut: {
				params: Record<string, never>;
				response: AuthRpcResult<void>;
			};
			getMonitoringStatus: {
				params: Record<string, never>;
				response: LocalMonitoringStatus;
			};
			configureMonitoring: {
				params: LocalMonitoringConfigure;
				response: LocalMonitoringStatus;
			};
			pauseMonitoring: {
				params: Record<string, never>;
				response: LocalMonitoringStatus;
			};
			resumeMonitoring: {
				params: Record<string, never>;
				response: LocalMonitoringStatus;
			};
			refreshMonitoringPermissions: {
				params: Record<string, never>;
				response: LocalMonitoringStatus;
			};
			setupMonitoringPermissions: {
				params: Record<string, never>;
				response: LocalMonitoringStatus;
			};
			openMonitoringPermissionSettings: {
				params: { permission: MonitoringPermissionSettingsTarget };
				response: { opened: boolean };
			};
			getContentVaultStatus: {
				params: Record<string, never>;
				response: LocalVaultKeyStatus;
			};
			migrateLegacyContentVault: {
				params: Record<string, never>;
				response:
					| { status: "cancelled"; vault: LocalVaultKeyStatus }
					| {
							status: "completed";
							result: LocalVaultLegacyMigrationResult;
					  };
			};
			exportFiveMinuteAuditToFile: {
				params: FiveMinuteAuditFileExportRequest;
				response: FiveMinuteAuditFileExportResult;
			};
			exportPrivateTrainingWindows: {
				params: PrivateTrainingWindowExportRequest;
				response: PrivateTrainingWindowExportStatus;
			};
			getPrivateTrainingWindowExportStatus: {
				params: Record<string, never>;
				response: PrivateTrainingWindowExportStatus;
			};
			startFiveMinuteAuditCapture: {
				params: Record<string, never>;
				response: FiveMinuteAuditCaptureStatus;
			};
			getFiveMinuteAuditCaptureStatus: {
				params: Record<string, never>;
				response: { capture: FiveMinuteAuditCaptureStatus | null };
			};
			cancelFiveMinuteAuditCapture: {
				params: { captureId: string };
				response: { capture: FiveMinuteAuditCaptureStatus | null };
			};
			loadCalendar: {
				params: Record<string, never>;
				response: CalendarLoadResponse;
			};
			mutateCalendar: {
				params: CalendarMutation;
				response: CalendarMutationResult;
			};
			mutateCalendarBatch: {
				params: {
					batchId: string;
					mutations: readonly CalendarMutation[];
					expectedRevision?: number;
				};
				response: CalendarBatchMutationResult;
			};
			getLocalStatus: {
				params: Record<string, never>;
				response: LocalRuntimeStatus;
			};
			setPetVisible: {
				params: { visible: boolean };
				response: { visible: boolean };
			};
			presentPetEvent: {
				params: PetPresentationEvent;
				response: { accepted: boolean };
			};
			setActiveGoalContext: {
				params: { goal: ActiveGoalContextV1 | null };
				response: { goal: ActiveGoalContextV1 | null };
			};
			startConversationTurn: {
				params: StartConversationTurnRequest;
				response: AgentRunRpcResult<AgentRunAccepted>;
			};
			startTaskPlanningRun: {
				params: StartTaskPlanningRunRequest;
				response: AgentRunRpcResult<AgentRunAccepted>;
			};
			submitPlanningClarification: {
				params: SubmitPlanningClarificationRequest;
				response: AgentRunRpcResult<AgentRunCommandAccepted>;
			};
			decideAgentToolApproval: {
				params: DecideAgentToolApprovalRequest;
				response: AgentRunRpcResult<AgentRunCommandAccepted>;
			};
			cancelAgentRun: {
				params: CancelAgentRunRequest;
				response: AgentRunRpcResult<AgentRunCommandAccepted>;
			};
			getAgentRunSnapshot: {
				params: GetAgentRunSnapshotRequest;
				response: AgentRunRpcResult<AgentRunSnapshot>;
			};
			listRestorableAgentRuns: {
				params: ListRestorableAgentRunsRequest;
				response: AgentRunRpcResult<{
					runs: readonly AgentRunRestorableSummary[];
				}>;
			};
			getActiveConversation: {
				params: Record<string, never>;
				response: ConversationRpcResult<ConversationRpcThread | null>;
			};
			loadPlanningAuthority: {
				params: Record<string, never>;
				response: PlanningAuthorityRpcResult<PlanningAuthoritySnapshot | null>;
			};
			savePlanningDraft: {
				params: SavePlanningDraftRequest;
				response: PlanningAuthorityRpcResult<PlanningAuthoritySnapshot>;
			};
			commitPlanningDraft: {
				params: CommitPlanningDraftRequest;
				response: PlanningAuthorityRpcResult<PlanningCommitResult>;
			};
		};
		messages: Record<never, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			appUpdateStatusChanged: AppUpdateSnapshot;
			proactiveFeedbackAvailable: ProactiveFeedbackAvailable;
			agentRunEvent: AgentRunEventEnvelope;
			authSessionExpired: Record<string, never>;
			localStatusChanged: LocalRuntimeStatus;
			petVisibilityChanged: { visible: boolean };
			planChanged: PlanningChangeProjection;
			calendarChanged: { version: number };
			planningNotification: PlanningNotificationProjection;
		};
	}>;
};

export type PetRPC = {
	bun: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			ready: void;
			interacted: PetInteractionMessage;
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			setPetState: PetState;
			nativeDragChanged: NativePetDragState;
		};
	}>;
};
