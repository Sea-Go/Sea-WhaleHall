import type { LocalMonitoringStatus } from "../../agent/local-protocol";
import type {
	DataCenterConsentInput,
	DataCenterConsentSensor,
} from "./types";

/**
 * Maps the local monitoring configuration to DataCenter sensor consents.
 * application/accessibility/editor/input/goal events map to the activity
 * domain, browser events to browser, and presence events to presence.
 */
export function consentInputsFromMonitoring(
	status: LocalMonitoringStatus,
): DataCenterConsentInput[] {
	const enabled =
		status.enabled &&
		status.state !== "disabled" &&
		status.state !== "stopped";
	const dataLevel = status.captureContent ? 3 : 1;
	const browserGranted =
		enabled && status.permissions.automation === "granted";
	return [
		{
			sensor: "activity",
			granted: enabled,
			dataLevel,
			policyVersion: "v1",
		},
		{
			sensor: "presence",
			granted: enabled,
			dataLevel,
			policyVersion: "v1",
		},
		{
			sensor: "browser",
			granted: browserGranted,
			dataLevel,
			policyVersion: "v1",
		},
	];
}

export function isConsentSensor(value: unknown): value is DataCenterConsentSensor {
	return value === "activity" || value === "browser" || value === "presence";
}
