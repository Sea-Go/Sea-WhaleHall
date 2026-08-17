import { describe, expect, test } from "bun:test";
import { parseArguments } from "../scripts/provision-relay-owner";

describe("relay owner provisioning arguments", () => {
	test("rejects --config without a following path", () => {
		expect(() =>
			parseArguments(["--users", "/tmp/relay-users.json", "--config"]),
		).toThrow("--config 必须提供绝对路径。");
	});

	test("does not consume the next option as the deprecated config path", () => {
		expect(() =>
			parseArguments(["--config", "--users", "/tmp/relay-users.json"]),
		).toThrow("--config 必须提供绝对路径。");
	});

	test("retains a valid deprecated config path for the existing warning", () => {
		expect(
			parseArguments([
				"--config",
				"/tmp/retired-relay-config.json",
				"--users",
				"/tmp/relay-users.json",
			]),
		).toEqual({
			ignoredConfigPath: "/tmp/retired-relay-config.json",
			usersPath: "/tmp/relay-users.json",
			replace: false,
		});
	});
});
