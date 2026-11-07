import { describe, expect, test } from "bun:test";
import { MODEL_AGENT_IDS } from "../src/agent/mastra-host/model-agent-catalog";
import {
	LOCAL_TEST_ACCOUNT_ID,
	LocalTestAuthError,
	LocalTestAuthSessionManager,
} from "../src/bun/local-test-auth-session";
import { LOCAL_TEST_AUTH_EXPERIENCE } from "../src/shared/auth";

function controlledPromise() {
	let resolve!: () => void;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("LocalTestAuthSessionManager", () => {
	test("validates the documented experience credentials and binds the historical demo user", async () => {
		const manager = new LocalTestAuthSessionManager();

		await expect(
			manager.signInTestAccount({
				email: LOCAL_TEST_AUTH_EXPERIENCE.email,
				password: "wrong-password",
			}),
		).rejects.toMatchObject({ kind: "invalid-credentials" });
		expect(manager.getSession()).toBeNull();

		const session = await manager.signInTestAccount({
			email: `  ${LOCAL_TEST_AUTH_EXPERIENCE.email.toUpperCase()}  `,
			password: LOCAL_TEST_AUTH_EXPERIENCE.password,
		});
		expect(session.user).toEqual({
			id: "user-demo-wang-yiming",
			displayName: "王一鸣",
			email: "demo@whalehall.local",
			initials: "鸣",
		});
		expect(manager.accountId).toBe(LOCAL_TEST_ACCOUNT_ID);
		expect(JSON.stringify(session)).not.toContain("password");
		expect(JSON.stringify(session)).not.toContain("token");
	});

	test("invalidates account state synchronously and completes every logout barrier", async () => {
		const cleanup = controlledPromise();
		const invalidated: Array<string | null> = [];
		const cleanupStarted = controlledPromise();
		const manager = new LocalTestAuthSessionManager({
			onSessionInvalidated: (accountId) => invalidated.push(accountId),
			onBeforeSessionClear: async () => {
				cleanupStarted.resolve();
				await cleanup.promise;
			},
		});
		await manager.signInTestAccount(LOCAL_TEST_AUTH_EXPERIENCE);
		const identity = manager.captureCurrentSession();
		expect(identity).not.toBeNull();

		const signOut = manager.signOut();
		expect(manager.getSession()).toBeNull();
		expect(invalidated).toEqual([LOCAL_TEST_ACCOUNT_ID]);
		if (identity) expect(manager.isCurrentSession(identity)).toBe(false);
		await cleanupStarted.promise;
		cleanup.resolve();
		await signOut;
	});
});
