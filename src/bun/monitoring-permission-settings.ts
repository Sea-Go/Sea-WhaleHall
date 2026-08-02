import type { MonitoringPermissionSettingsTarget } from "../shared/contracts";

const SYSTEM_SETTINGS_URLS: Record<
	MonitoringPermissionSettingsTarget,
	string
> = {
	accessibility:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	screenRecording:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	inputMonitoring:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
	browserAutomation:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};

export function monitoringPermissionSettingsUrl(
	permission: unknown,
): string | null {
	if (
		permission !== "accessibility" &&
		permission !== "screenRecording" &&
		permission !== "inputMonitoring" &&
		permission !== "browserAutomation"
	) {
		return null;
	}
	return SYSTEM_SETTINGS_URLS[permission];
}
