import { describe, expect, test } from "bun:test";
import {
	isLocalVaultKeyStatus,
	isLocalVaultLegacyMigrationResult,
} from "../src/agent/local-protocol";

describe("local content-vault setup protocol", () => {
	test("accepts bounded content-free status and migration results", () => {
		const pending = {
			availability: "migration_required",
			storageMode: null,
			keyVersion: null,
			interactiveMigrationAvailable: true,
		};
		const ready = {
			availability: "available",
			storageMode: "local_login_keychain",
			keyVersion: "keychain-dev-legacy-v1",
			interactiveMigrationAvailable: false,
		};
		expect(isLocalVaultKeyStatus(pending)).toBe(true);
		expect(isLocalVaultKeyStatus(ready)).toBe(true);
		expect(
			isLocalVaultLegacyMigrationResult({
				migrated: true,
				status: ready,
			}),
		).toBe(true);
	});

	test("rejects widened, contradictory, or key-bearing responses", () => {
		expect(
			isLocalVaultKeyStatus({
				availability: "available",
				storageMode: null,
				keyVersion: null,
				interactiveMigrationAvailable: false,
			}),
		).toBe(false);
		expect(
			isLocalVaultKeyStatus({
				availability: "migration_required",
				storageMode: null,
				keyVersion: null,
				interactiveMigrationAvailable: true,
				keyBytes: "must-never-cross-protocol",
			}),
		).toBe(false);
		expect(
			isLocalVaultLegacyMigrationResult({
				migrated: true,
				status: {
					availability: "available",
					storageMode: "local_login_keychain",
					keyVersion: "keychain-dev-legacy-v1",
					interactiveMigrationAvailable: false,
				},
				legacyDeleted: true,
			}),
		).toBe(false);
	});
});
