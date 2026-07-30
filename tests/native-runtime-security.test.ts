import { describe, expect, test } from "bun:test";
import {
	isObservationEncryptionUnavailable,
	nativeRuntimeSecurityEnvironment,
	parseNativeRuntimeChannel,
} from "../src/bun/native-runtime-security";

describe("native runtime security channel", () => {
	test.each(["dev", "canary", "stable"] as const)(
		"accepts the Electrobun %s channel",
		(channel) => {
			expect(parseNativeRuntimeChannel(channel)).toBe(channel);
		},
	);

	test.each([undefined, "", "production", "Stable", "nightly"])(
		"rejects unsupported channel %p",
		(channel) => {
			expect(() => parseNativeRuntimeChannel(channel)).toThrow(
				"Unsupported WhaleHall runtime channel",
			);
		},
	);

	test("always forwards the channel and limits the legacy Keychain opt-in to macOS dev/canary", () => {
		expect(nativeRuntimeSecurityEnvironment("dev", "darwin")).toEqual({
			WHALEHALL_RUNTIME_CHANNEL: "dev",
			WHALEHALL_ALLOW_LEGACY_DEV_KEYCHAIN: "true",
		});
		expect(nativeRuntimeSecurityEnvironment("canary", "darwin")).toEqual({
			WHALEHALL_RUNTIME_CHANNEL: "canary",
			WHALEHALL_ALLOW_LEGACY_DEV_KEYCHAIN: "true",
		});
		expect(nativeRuntimeSecurityEnvironment("stable", "darwin")).toEqual({
			WHALEHALL_RUNTIME_CHANNEL: "stable",
		});
		expect(nativeRuntimeSecurityEnvironment("dev", "linux")).toEqual({
			WHALEHALL_RUNTIME_CHANNEL: "dev",
		});
	});

	test("recognizes only the exact fail-closed vault availability error", () => {
		const expected = Object.assign(
			new Error("Observation content encryption is unavailable"),
			{ code: "PERMISSION_DENIED" },
		);
		expect(isObservationEncryptionUnavailable(expected)).toBeTrue();
		expect(
			isObservationEncryptionUnavailable(
				Object.assign(new Error("other"), {
					code: "PERMISSION_DENIED",
				}),
			),
		).toBeFalse();
		expect(
			isObservationEncryptionUnavailable(
				Object.assign(
					new Error("Observation content encryption is unavailable"),
					{ code: "INTERNAL" },
				),
			),
		).toBeFalse();
	});
});
