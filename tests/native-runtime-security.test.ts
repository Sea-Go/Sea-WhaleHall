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


});
