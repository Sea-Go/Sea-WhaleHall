import { AppShell } from "./app/AppShell";
import { applyAppearancePreferences } from "./app/appearance";
import { AuthGate } from "./features/auth/public";
import { PlanningController } from "./features/planning/public";
import { ReportController } from "./features/reports/public";
import { PreferencesController } from "./features/settings/public";
import {
	MockAuthService,
	MOCK_AUTH_EXPERIENCE,
} from "./infrastructure/auth/MockAuthService";
import { MockCalendarService } from "./infrastructure/calendar/MockCalendarService";
import { CalendarPlanningGateway } from "./infrastructure/planning/CalendarPlanningGateway";
import { MockPlanningGenerationService } from "./infrastructure/planning/MockPlanningGenerationService";
import { MockReportService } from "./infrastructure/reports/MockReportService";
import { ElectrobunPetPresentationBridge } from "./infrastructure/pet-bridge/ElectrobunPetPresentationBridge";
import { MockPreferencesService } from "./infrastructure/settings/MockPreferencesService";
import {
	ActiveGoalSyncCoordinator,
	clearGoalBeforeAccountTransition,
} from "./goal-sync";
import { Temporal } from "temporal-polyfill";
import { useEffect, useRef } from "react";

const authService = new MockAuthService();
const calendarService = new MockCalendarService();
const planningGenerator = new MockPlanningGenerationService();
const planningCalendarGateway = new CalendarPlanningGateway(calendarService);
const planningTimeZone =
	Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const currentDate = () =>
	Temporal.Now.zonedDateTimeISO(planningTimeZone)
		.toPlainDate()
		.toString();
const planningController = new PlanningController(
	planningGenerator,
	planningCalendarGateway,
	currentDate,
	() => planningTimeZone,
);
const activeGoalSynchronizer = new ActiveGoalSyncCoordinator({
	send: async (goal) => {
		if (!hasElectrobunRuntime()) {
			throw new Error("Electrobun runtime is not ready.");
		}
		const { clientApi } = await import("./rpc");
		const response = await clientApi.setActiveGoalContext(goal);
		return response.goal;
	},
	onRetry: (attempt) => {
		if (attempt !== 1 && attempt % 30 !== 0) return;
		console.warn("[planning] active goal sync is waiting for runtime ACK", {
			operation: "set-active-goal-context",
			category: "transport",
			attempt,
		});
	},
});
planningController.subscribe(() => {
	activeGoalSynchronizer.setDesired(
		planningController.getActiveGoalContext(),
	);
});
const reportController = new ReportController(
	new MockReportService(),
	currentDate,
);
const preferencesController = new PreferencesController(
	new MockPreferencesService(),
);
const petBridge = new ElectrobunPetPresentationBridge();

export function App() {
	const logoutPendingRef = useRef(false);
	const enableQaControls =
		typeof window !== "undefined" &&
		new URLSearchParams(window.location.search).get("qa") === "1";

	useEffect(() => {
		// The planning mock does not restore a goal across launches. Sync its
		// initial null state so a persisted runtime goal cannot survive a restart
		// or a previous account session without a matching visible plan.
		activeGoalSynchronizer.setDesired(
			planningController.getActiveGoalContext(),
		);
	}, []);

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
					<AppShell
						user={session.user}
						onLogout={() => {
							if (logoutPendingRef.current) return;
							logoutPendingRef.current = true;
							void clearGoalBeforeAccountTransition({
								clearLocalGoal: () => {
									planningController.clearActiveGoalContext();
								},
								synchronizer: activeGoalSynchronizer,
								transition: logout,
							}).finally(() => {
								logoutPendingRef.current = false;
							});
						}}
					calendarService={calendarService}
					planningController={planningController}
					reportController={reportController}
					preferencesController={preferencesController}
					petBridge={petBridge}
					enableQaControls={enableQaControls}
				/>
			)}
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
