import { useEffect, useMemo, useRef } from "react";
import { Temporal } from "temporal-polyfill";
import packageMetadata from "../../../package.json";
import { AppShell } from "./app/AppShell";
import { applyAppearancePreferences } from "./app/appearance";
import { subscribePetVisibilityPreference } from "./app/pet-visibility-preference";
import {
	AppUpdateController,
	UpdateStatusControl,
} from "./features/app-update/public";
import { AuthGate, type AuthSession } from "./features/auth/public";
import { CalendarController } from "./features/calendar/public";
import { ConversationController } from "./features/conversation/public";
import { MonitoringController } from "./features/monitoring/public";
import { PlanningController } from "./features/planning/public";
import {
	ProactiveFeedbackHistoryController,
	ProactiveFeedbackPolicyController,
} from "./features/proactive-feedback/public";
import { ReportController } from "./features/reports/public";
import {
	AgentPermissionsController,
	PreferencesController,
} from "./features/settings/public";
import { beginAccountTransition } from "./goal-sync";
import { ElectrobunAppUpdateService } from "./infrastructure/app-update/ElectrobunAppUpdateService";
import { ElectrobunAuditExportService } from "./infrastructure/audit-export/ElectrobunAuditExportService";
import { ElectrobunAuthService } from "./infrastructure/auth/ElectrobunAuthService";
import { MockAuthService } from "./infrastructure/auth/MockAuthService";
import { ElectrobunCalendarService } from "./infrastructure/calendar/ElectrobunCalendarService";
import { MockCalendarService } from "./infrastructure/calendar/MockCalendarService";
import { ElectrobunConversationService } from "./infrastructure/conversation/ElectrobunConversationService";
import { ElectrobunMonitoringService } from "./infrastructure/monitoring/ElectrobunMonitoringService";
import { ElectrobunPetPresentationBridge } from "./infrastructure/pet-bridge/ElectrobunPetPresentationBridge";
import { ElectrobunPlanningService } from "./infrastructure/planning/ElectrobunPlanningService";
import { ElectrobunProactiveFeedbackService } from "./infrastructure/proactive-feedback/ElectrobunProactiveFeedbackService";
import { InMemoryProactiveFeedbackService } from "./infrastructure/proactive-feedback/InMemoryProactiveFeedbackService";
import { MockReportService } from "./infrastructure/reports/MockReportService";
import { ElectrobunAgentPermissionsService } from "./infrastructure/settings/ElectrobunAgentPermissionsService";
import { MockAgentPermissionsService } from "./infrastructure/settings/MockAgentPermissionsService";
import { MockPreferencesService } from "./infrastructure/settings/MockPreferencesService";
import { useStrictModeSafeDispose } from "./use-strict-mode-safe-dispose";

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
	Temporal.Now.zonedDateTimeISO(planningTimeZone).toPlainDate().toString();
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
const appUpdateController = new AppUpdateController(
	new ElectrobunAppUpdateService({
		fallbackCurrentVersion: packageMetadata.version,
	}),
);

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
		const unsubscribePetVisibility = subscribePetVisibilityPreference(
			preferencesController,
			petBridge,
		);
		syncAppearanceFromPreferences();
		if (preferencesController.getSnapshot().status === "idle") {
			void preferencesController.load();
		}
		return () => {
			unsubscribe();
			unsubscribePetVisibility();
		};
	}, []);

	useEffect(() => {
		appUpdateController.start();
		return () => appUpdateController.stop();
	}, []);

	return (
		<>
			<AuthGate
				service={authService}
				renderAuthenticated={({ session, logout }) => (
					<AuthenticatedApp
						key={session.user.id}
						session={session}
						enableQaControls={enableQaControls}
						onLogout={logout}
					/>
				)}
			/>
			<UpdateStatusControl controller={appUpdateController} />
		</>
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
		[],
	);
	const planningController = useMemo(
		() => new PlanningController(new ElectrobunPlanningService()),
		[],
	);
	const conversationController = useMemo(
		() => new ConversationController(new ElectrobunConversationService()),
		[],
	);
	const proactiveFeedbackService = useMemo(
		() =>
			desktopRuntime
				? new ElectrobunProactiveFeedbackService()
				: new InMemoryProactiveFeedbackService(),
		[],
	);
	const proactiveFeedbackHistoryController = useMemo(
		() => new ProactiveFeedbackHistoryController(proactiveFeedbackService),
		[proactiveFeedbackService],
	);
	const proactiveFeedbackPolicyController = useMemo(
		() => new ProactiveFeedbackPolicyController(proactiveFeedbackService),
		[proactiveFeedbackService],
	);

	useEffect(() => {
		return () => calendarController.clearAccountData();
	}, [calendarController]);

	const agentPermissionsController = useMemo(
		() =>
			new AgentPermissionsController(
				desktopRuntime
					? new ElectrobunAgentPermissionsService()
					: new MockAgentPermissionsService(),
			),
		[],
	);
	useStrictModeSafeDispose(proactiveFeedbackHistoryController, (controller) =>
		controller.dispose(),
	);
	useStrictModeSafeDispose(proactiveFeedbackPolicyController, (controller) =>
		controller.dispose(),
	);
	useStrictModeSafeDispose(planningController, (controller) =>
		controller.dispose(),
	);
	useStrictModeSafeDispose(conversationController, (controller) =>
		controller.dispose(),
	);

	const handleLogout = () => {
		if (logoutPendingRef.current) return;
		logoutPendingRef.current = true;
		beginAccountTransition({
			transition: onLogout,
			clearLocalAccountState: () => {
				proactiveFeedbackPolicyController.dispose();
				calendarController.clearAccountData();
				planningController.dispose();
				conversationController.dispose();
			},
		});
	};

	return (
		<AppShell
			user={session.user}
			onLogout={handleLogout}
			calendarService={calendarService}
			calendarController={calendarController}
			conversationController={conversationController}
			planningController={planningController}
			reportController={reportController}
			preferencesController={preferencesController}
			agentPermissionsController={agentPermissionsController}
			petBridge={petBridge}
			monitoringController={monitoringController}
			auditExportService={auditExportService}
			proactiveFeedbackHistoryController={proactiveFeedbackHistoryController}
			proactiveFeedbackPolicyController={proactiveFeedbackPolicyController}
			appUpdateController={appUpdateController}
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
