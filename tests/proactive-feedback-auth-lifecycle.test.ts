import { describe, expect, test } from "bun:test";
import { ProactiveFeedbackRuntime } from "../src/bun/proactive-feedback-runtime";
import {
	RemoteAuthSessionManager,
	type SecureCredentialStore,
} from "../src/bun/remote-auth-session";
import type { ProactiveFeedbackPolicy } from "../src/shared/proactive-feedback";

const refreshTokenKey = "auth.refresh-token.production.v1";

class MemoryCredentials implements SecureCredentialStore {
	readonly values = new Map<string, string>();

	async read(name: string): Promise<string | null> {
		return this.values.get(name) ?? null;
	}

	async write(name: string, value: string): Promise<void> {
		this.values.set(name, value);
	}

	async delete(name: string): Promise<void> {
		this.values.delete(name);
	}
}

describe("optional proactive feedback auth lifecycle", () => {
	test("does not publish or persist a session when the old pet cannot be cleared", async () => {
		const fixture = createAuthFixture({ petClearUnavailable: true });

		await expect(fixture.signIn()).rejects.toThrow("previous pet presentation");
		expect(fixture.manager.accountId).toBeNull();
		expect(fixture.credentials.values.has(refreshTokenKey)).toBeFalse();
		expect(fixture.calls).toEqual(["clear-pet"]);
		expect(fixture.errors).toHaveLength(1);
		fixture.runtime.dispose();
	});

	test("does not publish a replacement session when durable owner revocation keeps failing", async () => {
		const replacementRefreshToken =
			"refresh-token-account-a-replacement-0123456789";
		const fixture = createAuthFixture({
			successfulNullCutoversBeforeFailure: 1,
		});
		await fixture.signIn();
		expect(fixture.manager.accountId).toBe("account-a");

		await expect(fixture.signIn()).rejects.toThrow(
			"previous proactive feedback owner",
		);
		expect(fixture.manager.accountId).toBeNull();
		expect(fixture.credentials.values.get(refreshTokenKey)).not.toBe(
			replacementRefreshToken,
		);
		expect(
			fixture.calls.filter((call) => call === "cutover:null"),
		).toHaveLength(3);
		fixture.runtime.dispose();
	});

	test("keeps login and refresh token when proactive storage is unavailable", async () => {
		const fixture = createAuthFixture({ storageUnavailable: true });

		await expect(fixture.signIn()).resolves.toMatchObject({
			id: "session-account-a",
		});
		expect(fixture.manager.accountId).toBe("account-a");
		expect(fixture.credentials.values.get(refreshTokenKey)).toBe(
			"refresh-token-account-a-0123456789",
		);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.calls.filter((call) => call === "stop:false")).toHaveLength(
			2,
		);
		expect(fixture.calls).not.toContain("clear-pending");
		expect(fixture.errors).toHaveLength(2);
		fixture.runtime.dispose();
	});

	test("keeps login when proactive owner cutover fails after publication", async () => {
		const fixture = createAuthFixture({ accountCutoverFailures: 1 });

		await expect(fixture.signIn()).resolves.toMatchObject({
			id: "session-account-a",
		});
		expect(fixture.manager.accountId).toBe("account-a");
		expect(fixture.credentials.values.get(refreshTokenKey)).toBe(
			"refresh-token-account-a-0123456789",
		);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.calls).toContain("cutover:account-a");
		expect(fixture.calls).toContain("stop:false");
		expect(fixture.calls).not.toContain("start");
		expect(fixture.errors).toHaveLength(1);
		fixture.runtime.dispose();
	});

	for (const scenario of [
		{
			name: "policy is disabled",
			policy: { enabled: false, retention: 30 } as ProactiveFeedbackPolicy,
			capabilityAvailable: true,
		},
		{
			name: "model relay capability is absent",
			policy: { enabled: true, retention: 30 } as ProactiveFeedbackPolicy,
			capabilityAvailable: false,
		},
	]) {
		test(`keeps login inactive when ${scenario.name}`, async () => {
			const fixture = createAuthFixture(scenario);

			await expect(fixture.signIn()).resolves.toMatchObject({
				id: "session-account-a",
			});
			expect(fixture.manager.accountId).toBe("account-a");
			expect(fixture.credentials.values.has(refreshTokenKey)).toBeTrue();
			expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
			expect(fixture.calls).not.toContain("cutover:account-a");
			expect(fixture.calls).not.toContain("start");
			expect(fixture.errors).toEqual([]);
			fixture.runtime.dispose();
		});
	}
});

function createAuthFixture(options?: {
	storageUnavailable?: boolean;
	accountCutoverFailures?: number;
	policy?: ProactiveFeedbackPolicy;
	capabilityAvailable?: boolean;
	petClearUnavailable?: boolean;
	successfulNullCutoversBeforeFailure?: number;
}): {
	runtime: ProactiveFeedbackRuntime;
	manager: RemoteAuthSessionManager;
	credentials: MemoryCredentials;
	calls: string[];
	errors: unknown[];
	signIn(): ReturnType<RemoteAuthSessionManager["signIn"]>;
} {
	const credentials = new MemoryCredentials();
	const calls: string[] = [];
	const errors: unknown[] = [];
	const policy = options?.policy ?? { enabled: true, retention: 30 };
	let accountCutoverFailures = options?.accountCutoverFailures ?? 0;
	let successfulNullCutoversBeforeFailure =
		options?.successfulNullCutoversBeforeFailure ?? Number.POSITIVE_INFINITY;
	let authenticationCount = 0;
	let manager!: RemoteAuthSessionManager;
	const runtime = new ProactiveFeedbackRuntime({
		repository: {
			ensureAccount: async () => {
				calls.push("ensure");
				if (options?.storageUnavailable) {
					throw new Error("proactive storage unavailable");
				}
			},
			getProactiveFeedbackPolicy: async () => {
				calls.push("policy");
				if (options?.storageUnavailable) {
					throw new Error("proactive storage unavailable");
				}
				return { policy: { ...policy }, revision: 0, updatedAtMs: null };
			},
			setProactiveFeedbackPolicy: async () => {
				throw new Error("not used");
			},
			listProactiveFeedback: async () => ({ items: [], nextCursor: null }),
			clearPendingProactiveFeedbackData: async () => {
				calls.push("clear-pending");
			},
			beginProactiveFeedbackPendingReset: async () => undefined,
			isProactiveFeedbackPendingReset: async () => false,
			completeProactiveFeedbackPendingReset: async () => undefined,
			beginProactiveFeedbackClear: async () => undefined,
			isProactiveFeedbackClearPending: async () => false,
			completeProactiveFeedbackClear: async () => undefined,
			clearProactiveFeedbackData: async () => ({ clearedAtMs: 1 }),
			cleanupProactiveFeedback: async () => {
				calls.push("cleanup");
			},
		},
		currentSession: () => manager.captureCurrentSession(),
		isCurrentSession: (identity) => manager.isCurrentSession(identity),
		isCapabilityAvailable: () => options?.capabilityAvailable ?? true,
		cutoverCloudOwner: async (accountId) => {
			calls.push(`cutover:${accountId ?? "null"}`);
			if (accountId === null) {
				if (successfulNullCutoversBeforeFailure <= 0) {
					throw new Error("durable owner revocation failed");
				}
				successfulNullCutoversBeforeFailure -= 1;
			}
			if (accountId !== null && accountCutoverFailures > 0) {
				accountCutoverFailures -= 1;
				throw new Error("proactive owner cutover failed");
			}
		},
		startDelivery: async () => {
			calls.push("start");
		},
		stopDelivery: async ({ clearPending }) => {
			calls.push(`stop:${clearPending}`);
		},
		abortActivityRequests: () => {
			calls.push("abort");
		},
		clearPetPresentation: async () => {
			calls.push("clear-pet");
			if (options?.petClearUnavailable) {
				throw new Error("pet clear and native hide failed");
			}
		},
		quiesceActivityRuns: async () => {
			calls.push("quiesce");
		},
		discardActivityRuns: async () => {
			calls.push("cancel");
		},
		clearReflectionHandoffs: async () => {
			calls.push("clear-reflection");
		},
		protectedActivityRunIds: () => [],
		setInterval: (() => 1) as unknown as typeof globalThis.setInterval,
		clearInterval: (() => {}) as typeof globalThis.clearInterval,
		onError: (error) => {
			errors.push(error);
		},
	});
	manager = new RemoteAuthSessionManager(credentials, {
		baseUrl: "https://relay.example.test",
		onBeforeSessionActivate: (identity) =>
			runtime.prepareSessionActivationForAuth(identity),
		onSessionActivated: (identity) => runtime.sessionReadyForAuth(identity),
		fetch: (async () => {
			authenticationCount += 1;
			return Response.json({
				id: "session-account-a",
				accessToken: "access-token-account-a-0123456789",
				refreshToken:
					authenticationCount === 1
						? "refresh-token-account-a-0123456789"
						: "refresh-token-account-a-replacement-0123456789",
				expiresAtMs: Date.now() + 15 * 60_000,
				user: {
					id: "account-a",
					displayName: "测试用户",
					email: "test@example.com",
					initials: "测试",
				},
			});
		}) as unknown as typeof fetch,
	});

	return {
		runtime,
		manager,
		credentials,
		calls,
		errors,
		signIn: () =>
			manager.signIn({
				email: "test@example.com",
				password: "password",
			}),
	};
}
