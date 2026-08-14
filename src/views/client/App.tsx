import { AppShell } from "./app/AppShell";
import { applyAppearancePreferences } from "./app/appearance";
import { qaControlsEnabled } from "./app/qa-mode";
import { AuthGate } from "./features/auth/public";
import { PlanningController } from "./features/planning/public";
import { MonitoringController } from "./features/monitoring/public";
import { ReportController } from "./features/reports/public";
import { PreferencesController } from "./features/settings/public";
import { DataCenterAuthService } from "./infrastructure/auth/DataCenterAuthService";
import { ElectrobunCalendarService } from "./infrastructure/calendar/ElectrobunCalendarService";
import { ElectrobunPlanningService } from "./infrastructure/planning/ElectrobunPlanningService";
import { MockReportService } from "./infrastructure/reports/MockReportService";
import { ElectrobunPetPresentationBridge } from "./infrastructure/pet-bridge/ElectrobunPetPresentationBridge";
import { ElectrobunMonitoringService } from "./infrastructure/monitoring/ElectrobunMonitoringService";
import { ElectrobunAuditExportService } from "./infrastructure/audit-export/ElectrobunAuditExportService";
import { ElectrobunCloudSyncService } from "./infrastructure/settings/ElectrobunCloudSyncService";
import {
	CloudSyncController,
} from "./features/settings/public";
import { MockPreferencesService } from "./infrastructure/settings/MockPreferencesService";
import { Temporal } from "temporal-polyfill";
import { useEffect, useRef } from "react";

const authService = new DataCenterAuthService();
const calendarService = new ElectrobunCalendarService();
const planningTimeZone =
	Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const currentDate = () =>
	Temporal.Now.zonedDateTimeISO(planningTimeZone)
		.toPlainDate()
		.toString();
const planningController = new PlanningController(
	new ElectrobunPlanningService(),
);
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
const cloudSyncController = new CloudSyncController(
	new ElectrobunCloudSyncService(),
);
const auditExportService = new ElectrobunAuditExportService();

export function App() {
	const logoutPendingRef = useRef(false);
	const enableQaControls =
		typeof window !== "undefined" &&
		qaControlsEnabled(window.location);

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
			renderAuthenticated={({ session, logout }) => (
					<AppShell
						user={session.user}
						onLogout={() => {
							if (logoutPendingRef.current) return;
							logoutPendingRef.current = true;
							void Promise.resolve(logout()).finally(() => {
								logoutPendingRef.current = false;
							});
						}}
					calendarService={calendarService}
					planningController={planningController}
					reportController={reportController}
					preferencesController={preferencesController}
					petBridge={petBridge}
					monitoringController={monitoringController}
					cloudSyncController={cloudSyncController}
					auditExportService={auditExportService}
					enableQaControls={enableQaControls}
				/>
			)}
		/>
	);
}
