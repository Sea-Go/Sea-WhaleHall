import type { RPCSchema } from 'electrobun/bun';
import type { PetActionId } from './pet-actions';
import type { PetPresentationEvent } from './pet-presentation';
import type { PetTodaySchedule } from './pet-panel';
import type { ActiveGoalContextV1 } from './goal-context';
import type { AuthCredentials, AuthRpcResult, AuthSession } from './auth';
import type {
	AgentReadPermissionsRpcResult,
	AgentReadPermissionsSnapshot,
	SetAgentReadPermissionsRequest,
} from './agent-permissions';
import type {
	CalendarBatchMutationResult,
	CalendarLoadResponse,
	CalendarMutation,
	CalendarMutationResult,
} from './calendar';
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
} from './agent-runs';
import type {
	ConversationRpcResult,
	ConversationRpcSendResult,
	ConversationRpcThread,
} from './conversation';
import type {
	TaskPlanningAnswer,
	TaskPlanningInput,
	TaskPlanningRpcResult,
	TaskPlanningSession,
} from './task-planning';
import type {
	CommitPlanningDraftRequest,
	PlanningAuthorityRpcResult,
	PlanningAuthoritySnapshot,
	PlanningCommitResult,
	SavePlanningDraftRequest,
} from './planning-authority';
import type {
	LocalRuntimeStatus,
} from '../agent/local-protocol';

export type {
	AgentReadPermissionsRpcResult,
	AgentReadPermissionsSnapshot,
	SetAgentReadPermissionsRequest,
	AuthRpcResult,
	AuthSession,
	CalendarBatchMutationResult,
	CalendarLoadResponse,
	CalendarMutation,
	CalendarMutationResult,
	LocalRuntimeStatus,
	PetPresentationEvent,
	PetTodaySchedule,
	ActiveGoalContextV1,
};

export type {
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
};

export type {
	ConversationRpcResult,
	ConversationRpcSendResult,
	ConversationRpcThread,
};

export type {
	TaskPlanningAnswer,
	TaskPlanningInput,
	TaskPlanningRpcResult,
	TaskPlanningSession,
};

export type {
	CommitPlanningDraftRequest,
	PlanningAuthorityRpcResult,
	PlanningAuthoritySnapshot,
	PlanningCommitResult,
	SavePlanningDraftRequest,
};

export type PetMood = 'idle' | 'happy' | 'busy' | 'error';

/** Canonical, model-independent action identifier shared by every pet surface. */
export type PetAnimationId = PetActionId;

export type PetState = {
	mood: PetMood;
	message: string;
	action?: PetAnimationId;
	/** Registry id resolved by the renderer; unknown ids safely fall back to whale. */
	modelId?: string;
	environment?: {
		weather?: 'clear' | 'cloudy' | 'rain' | 'snow';
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
		| 'hover'
		| 'hoverEnd'
		| 'click'
		| 'doubleClick'
		| 'rapidClick'
		| 'pet'
		| 'petEnd'
		| 'poke'
		| 'dragStart'
		| 'dragEnd';
	action: PetAnimationId;
	modelId: string;
	zone?: 'head' | 'face' | 'body' | 'tail' | 'limb' | null;
	pointerId?: number;
	dragDelta?: { x: number; y: number };
};

export type NativePetDragState = {
	dragging: boolean;
	reason?: 'pointerup' | 'webview' | 'hidden' | 'disposed';
};

export type ClientRPC = {
	bun: RPCSchema<{
		requests: {
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
			updatePetTodaySchedule: {
				params: PetTodaySchedule;
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
				agentRunEvent: AgentRunEventEnvelope;
				authSessionExpired: Record<string, never>;
				localStatusChanged: LocalRuntimeStatus;
				petVisibilityChanged: { visible: boolean };
		};
	}>;
};

/** RPC surface for the compact schedule panel opened by a single pet click. */
export type PetPanelRPC = {
	bun: RPCSchema<{
		requests: {
			getTodaySchedule: {
				params: Record<never, never>;
				response: PetTodaySchedule;
			};
			closePetPanel: {
				params: Record<never, never>;
				response: { visible: boolean };
			};
			openMainWindow: {
				params: Record<never, never>;
				response: { visible: boolean };
			};
		};
		messages: Record<never, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: { todayScheduleChanged: PetTodaySchedule };
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
