import { AppShell } from "./app/AppShell";
import { applyAppearancePreferences } from "./app/appearance";
import { AuthGate, type AuthSession } from "./features/auth/public";
import { PlanningController } from "./features/planning/public";
import { MonitoringController } from "./features/monitoring/public";
import { ReportController } from "./features/reports/public";
import {
	AgentPermissionsController,
	PreferencesController,
} from "./features/settings/public";
import { ConversationController } from "./features/conversation/public";
import {
	MOCK_AUTH_EXPERIENCE,
	MockAuthService,
} from "./infrastructure/auth/MockAuthService";
import { ElectrobunAuthService } from "./infrastructure/auth/ElectrobunAuthService";
import { MockCalendarService } from "./infrastructure/calendar/MockCalendarService";
import { ElectrobunCalendarService } from "./infrastructure/calendar/ElectrobunCalendarService";
import { CalendarController } from "./features/calendar/public";
import { CalendarPlanningGateway } from "./infrastructure/planning/CalendarPlanningGateway";
import { AgentPlanningGenerationService } from "./infrastructure/planning/AgentPlanningGenerationService";
import { ElectrobunPlanningAuthorityGateway } from "./infrastructure/planning/ElectrobunPlanningAuthorityGateway";
import { MockReportService } from "./infrastructure/reports/MockReportService";
import { ElectrobunPetPresentationBridge } from "./infrastructure/pet-bridge/ElectrobunPetPresentationBridge";
import { ElectrobunMonitoringService } from "./infrastructure/monitoring/ElectrobunMonitoringService";
import { ElectrobunAuditExportService } from "./infrastructure/audit-export/ElectrobunAuditExportService";
import { MockPreferencesService } from "./infrastructure/settings/MockPreferencesService";
import { ElectrobunAgentPermissionsService } from "./infrastructure/settings/ElectrobunAgentPermissionsService";
import { MockAgentPermissionsService } from "./infrastructure/settings/MockAgentPermissionsService";
import { ElectrobunConversationService } from "./infrastructure/conversation/ElectrobunConversationService";
import { beginAccountTransition } from "./goal-sync";
import { Temporal } from "temporal-polyfill";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

const desktopRuntime = hasElectrobunRuntime();
const authService = desktopRuntime
	? new ElectrobunAuthService()
	: new MockAuthService();
const calendarService = desktopRuntime
	? new ElectrobunCalendarService()
	: new MockCalendarService();
const planningTimeZone =
	Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const currentDate = () =>
	Temporal.Now.zonedDateTimeISO(planningTimeZone)
		.toPlainDate()
		.toString();
const reportController = new ReportController(
	new MockReportService(),
	currentDate,
);
const preferencesController = new PreferencesController(
	new MockPreferencesService(),
);
const petBridge = new ElectrobunPetPresentationBridge();
const monitoringController = new MonitoringController(
	new ElectrobunMonitoringService(),
);
const auditExportService = new ElectrobunAuditExportService();

export function App() {
	const enableQaControls =
		typeof window !== "undefined" &&
		new URLSearchParams(window.location.search).get("qa") === "1";

	useEffect(() => {
		function syncAppearanceFromPreferences() {
			const state = preferencesController.getSnapshot();
			if (!("draft" in state)) return;
			applyAppearancePreferences(state.draft.appearance);
		}

		const unsubscribe = preferencesController.subscribe(
			syncAppearanceFromPreferences,
		);
		syncAppearanceFromPreferences();
		if (preferencesController.getSnapshot().status === "idle") {
			void preferencesController.load();
		}
		return unsubscribe;
	}, []);

	return (
		<AuthGate
			service={authService}
			experienceCredentials={MOCK_AUTH_EXPERIENCE}
			renderAuthenticated={({ session, logout }) => (
					<AuthenticatedApp
						session={session}
						enableQaControls={enableQaControls}
						onLogout={logout}
				/>
			)}
		/>
	);
}

function AuthenticatedApp({
	session,
	onLogout,
	enableQaControls,
}: {
	session: AuthSession;
	onLogout: () => void;
	enableQaControls: boolean;
}) {
	const logoutPendingRef = useRef(false);
	const calendarController = useMemo(
		() => new CalendarController(calendarService),
		[session.user.id],
	);
	const planningCalendarGateway = useMemo(
		() => new CalendarPlanningGateway(calendarService),
		[session.user.id],
	);
	const planningAuthorityGateway = useMemo(
		() => desktopRuntime ? new ElectrobunPlanningAuthorityGateway() : undefined,
		[session.user.id],
	);
	const planningController = useMemo(
		() => new PlanningController(
			new AgentPlanningGenerationService(),
			planningCalendarGateway,
			currentDate,
			() => planningTimeZone,
			undefined,
			undefined,
			planningAuthorityGateway,
		),
		[session.user.id],
	);
	const conversationController = useMemo(
		() => new ConversationController(new ElectrobunConversationService()),
		[planningCalendarGateway, session.user.id],
	);

	useEffect(() => {
		return () => calendarController.clearAccountData();
	}, [calendarController]);

	const agentPermissionsController = useMemo(
		() => new AgentPermissionsController(
			desktopRuntime
				? new ElectrobunAgentPermissionsService()
				: new MockAgentPermissionsService(),
		),
		[session.user.id],
	);
	const conversationState = useSyncExternalStore(
		conversationController.subscribe,
		conversationController.getSnapshot,
		conversationController.getServerSnapshot,
	);

	useEffect(() => {
		void conversationController.load();
		return () => conversationController.dispose();
	}, [conversationController]);

	useEffect(() => {
		void planningController.restore();
	}, [planningController]);

	const handleLogout = () => {
		if (logoutPendingRef.current) return;
		logoutPendingRef.current = true;
		beginAccountTransition({
			transition: onLogout,
			clearLocalAccountState: () => {
				calendarController.clearAccountData();
				planningController.clearActiveGoalContext();
			},
		});
	};

	return (
		<AppShell
			user={session.user}
			onLogout={handleLogout}
			calendarService={calendarService}
			calendarController={calendarController}
			planningController={planningController}
			reportController={reportController}
			preferencesController={preferencesController}
			agentPermissionsController={agentPermissionsController}
			petBridge={petBridge}
			monitoringController={monitoringController}
			auditExportService={auditExportService}
			conversationState={conversationState}
			conversationActions={{
				onCreateConversation: () => void conversationController.createConversation(),
				onSendMessage: (draft) => void conversationController.sendMessage(draft),
				onRetry: () => void conversationController.retry(),
				onStopRun: () => void conversationController.stopRun(),
				onApproveTool: () => void conversationController.approveTool(),
				onDeclineTool: () => void conversationController.declineTool(),
				onRestoreRun: (runId) => void conversationController.resumeInterruptedRun(runId),
			}}
			enableQaControls={enableQaControls}
		/>
	);
}
function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}
