import { describe, expect, test } from "bun:test";
import { LOCAL_TEST_AUTH_EXPERIENCE } from "../src/shared/auth";
import {
	LOCAL_TEST_ACCOUNT_ID,
	LocalTestAuthError,
	LocalTestAuthSessionManager,
} from "../src/bun/local-test-auth-session";

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

	test("does not resurrect a queued sign-in after a newer logout generation", async () => {
		const firstCleanup = controlledPromise();
		const firstCleanupStarted = controlledPromise();
		let cleanupCalls = 0;
		const manager = new LocalTestAuthSessionManager({
			onBeforeSessionClear: async () => {
				cleanupCalls += 1;
				if (cleanupCalls === 1) {
					firstCleanupStarted.resolve();
					await firstCleanup.promise;
				}
			},
		});
		await manager.signInTestAccount(LOCAL_TEST_AUTH_EXPERIENCE);

		const firstLogout = manager.signOut();
		await firstCleanupStarted.promise;
		const staleSignIn = manager.signInTestAccount(LOCAL_TEST_AUTH_EXPERIENCE);
		const newerLogout = manager.signOut();
		firstCleanup.resolve();

		await firstLogout;
		await expect(staleSignIn).rejects.toBeInstanceOf(LocalTestAuthError);
		await newerLogout;
		expect(manager.getSession()).toBeNull();
		expect(cleanupCalls).toBe(2);
	});

	test("still runs the asynchronous cleanup barrier if immediate invalidation throws", async () => {
		let cleanupRan = false;
		const manager = new LocalTestAuthSessionManager({
			onSessionInvalidated: () => {
				throw new Error("panel already closed");
			},
			onBeforeSessionClear: async () => {
				cleanupRan = true;
			},
		});
		await manager.signInTestAccount(LOCAL_TEST_AUTH_EXPERIENCE);
		await manager.signOut();
		expect(manager.getSession()).toBeNull();
		expect(cleanupRan).toBe(true);
	});

	test("fails model relay authorization closed", async () => {
		const manager = new LocalTestAuthSessionManager();
		await manager.signInTestAccount(LOCAL_TEST_AUTH_EXPERIENCE);
		await expect(manager.authorizedFetch("/v1/chat/completions")).rejects.toMatchObject({
			kind: "service-unavailable",
		});
	});
});
