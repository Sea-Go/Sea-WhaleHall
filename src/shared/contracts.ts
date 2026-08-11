import type { RPCSchema } from 'electrobun/bun';
import type { PetActionId } from './pet-actions';
import type { PetPresentationEvent } from './pet-presentation';
import type { ActiveGoalContextV1 } from './goal-context';
import type {
	LocalRuntimeStatus,
	LocalMonitoringConfigure,
	LocalMonitoringPermissionCheckState,
	LocalMonitoringPermissionState,
	LocalMonitoringStatus,
	LocalVaultKeyStatus,
	LocalVaultLegacyMigrationResult,
} from '../agent/local-protocol';
import type {
	DataCenterAuthSessionProjection,
	DataCenterSyncErrorCode,
	DataCenterSyncState,
	DataCenterSyncStatus,
} from './datacenter';

export type {
	LocalRuntimeStatus,
	LocalMonitoringConfigure,
	LocalMonitoringPermissionCheckState,
	LocalMonitoringPermissionState,
	LocalMonitoringStatus,
	LocalVaultKeyStatus,
	LocalVaultLegacyMigrationResult,
	PetPresentationEvent,
	ActiveGoalContextV1,
	DataCenterAuthSessionProjection,
	DataCenterSyncErrorCode,
	DataCenterSyncState,
	DataCenterSyncStatus,
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
	status:
		| 'exported'
		| 'cancelled'
		| 'invalid_range'
		| 'not_ready'
		| 'failed';
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
			getLocalStatus: {
				params: Record<string, never>;
				response: LocalRuntimeStatus;
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
					| { status: 'cancelled'; vault: LocalVaultKeyStatus }
					| {
							status: 'completed';
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
			datacenterSignIn: {
				params: { email: string; password: string };
				response: { session: DataCenterAuthSessionProjection };
			};
			datacenterSignOut: {
				params: Record<string, never>;
				response: { signedOut: boolean };
			};
			datacenterRestoreSession: {
				params: Record<string, never>;
				response: { session: DataCenterAuthSessionProjection | null };
			};
			datacenterSyncStatus: {
				params: Record<string, never>;
				response: { status: DataCenterSyncStatus };
			};
			datacenterSetSyncEnabled: {
				params: { enabled: boolean };
				response: { status: DataCenterSyncStatus };
			};
			datacenterRefreshConsents: {
				params: Record<string, never>;
				response: { status: DataCenterSyncStatus };
			};
		};
		messages: Record<never, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			localStatusChanged: LocalRuntimeStatus;
			petVisibilityChanged: { visible: boolean };
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
