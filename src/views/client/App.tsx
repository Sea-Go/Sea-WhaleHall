import { AppShell } from "./app/AppShell";
import { applyAppearancePreferences } from "./app/appearance";
import { AuthGate, type AuthSession } from "./features/auth/public";
import { PlanningController } from "./features/planning/public";
import { ReportController } from "./features/reports/public";
import { PreferencesController } from "./features/settings/public";
import { ConversationController } from "./features/conversation/public";
import {
	MockAuthService,
	MOCK_AUTH_EXPERIENCE,
} from "./infrastructure/auth/MockAuthService";
import { MockCalendarService } from "./infrastructure/calendar/MockCalendarService";
import { CalendarController } from "./features/calendar/public";
import { CalendarPlanningGateway } from "./infrastructure/planning/CalendarPlanningGateway";
import { AgentPlanningGenerationService } from "./infrastructure/planning/AgentPlanningGenerationService";
import { MockReportService } from "./infrastructure/reports/MockReportService";
import { ElectrobunPetPresentationBridge } from "./infrastructure/pet-bridge/ElectrobunPetPresentationBridge";
import { MockPreferencesService } from "./infrastructure/settings/MockPreferencesService";
import { ElectrobunConversationService } from "./infrastructure/conversation/ElectrobunConversationService";
import {
	ActiveGoalSyncCoordinator,
	clearGoalBeforeAccountTransition,
} from "./goal-sync";
import { Temporal } from "temporal-polyfill";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

const authService = new MockAuthService();
const calendarService = new MockCalendarService();
const calendarController = new CalendarController(calendarService);
const planningCalendarGateway = new CalendarPlanningGateway(calendarService);
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
	const planningController = useMemo(
		() => new PlanningController(
			new AgentPlanningGenerationService(session.user.id),
			planningCalendarGateway,
			currentDate,
			() => planningTimeZone,
		),
		[session.user.id],
	);
	const activeGoalSynchronizer = useMemo(
		() => new ActiveGoalSyncCoordinator({
			send: async (goal) => {
				if (!hasElectrobunRuntime()) throw new Error("Electrobun runtime is not ready.");
				const { clientApi } = await import("./rpc");
				return (await clientApi.setActiveGoalContext(goal)).goal;
			},
			onRetry: (attempt) => {
				if (attempt !== 1 && attempt % 30 !== 0) return;
				console.warn("[planning] active goal sync is waiting for runtime ACK", { operation: "set-active-goal-context", category: "transport", attempt });
			},
		}),
		[],
	);
	const conversationController = useMemo(
		() => new ConversationController(new ElectrobunConversationService(session.user.id)),
		[session.user.id],
	);
	const conversationState = useSyncExternalStore(
		conversationController.subscribe,
		conversationController.getSnapshot,
		conversationController.getServerSnapshot,
	);

	useEffect(() => {
		void conversationController.load();
	}, [conversationController]);

	useEffect(() => {
		const sync = () => activeGoalSynchronizer.setDesired(planningController.getActiveGoalContext());
		const unsubscribe = planningController.subscribe(sync);
		sync();
		return unsubscribe;
	}, [activeGoalSynchronizer, planningController]);

	const handleLogout = () => {
		if (logoutPendingRef.current) return;
		logoutPendingRef.current = true;
		void clearGoalBeforeAccountTransition({
			clearLocalGoal: () => planningController.clearActiveGoalContext(),
			synchronizer: activeGoalSynchronizer,
			transition: onLogout,
		}).finally(() => { logoutPendingRef.current = false; });
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
			petBridge={petBridge}
			conversationState={conversationState}
			conversationActions={{
				onCreateConversation: () => void conversationController.createConversation(),
				onSendMessage: (draft) => void conversationController.sendMessage(draft),
				onRetry: () => void conversationController.retry(),
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
