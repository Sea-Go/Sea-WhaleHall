import { describe, expect, test } from "bun:test";
import { monitoringPermissionSettingsUrl } from "../src/bun/monitoring-permission-settings";

describe("macOS monitoring permission settings", () => {
	test("maps every permission card to its dedicated System Settings pane", () => {
		expect(monitoringPermissionSettingsUrl("accessibility")).toEndWith(
			"Privacy_Accessibility",
		);
		expect(monitoringPermissionSettingsUrl("screenRecording")).toEndWith(
			"Privacy_ScreenCapture",
		);
		expect(monitoringPermissionSettingsUrl("inputMonitoring")).toEndWith(
			"Privacy_ListenEvent",
		);
		expect(monitoringPermissionSettingsUrl("browserAutomation")).toEndWith(
			"Privacy_Automation",
		);
		expect(monitoringPermissionSettingsUrl("generalPrivacy")).toBeNull();
	});
});
