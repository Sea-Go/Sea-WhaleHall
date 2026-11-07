import { describe, expect, test } from "bun:test";
import { ProactiveFeedbackRuntime } from "../src/bun/proactive-feedback-runtime";
import type {
	ProactiveFeedbackPolicy,
	ProactiveFeedbackPolicySnapshot,
} from "../src/shared/proactive-feedback";
import type { AuthSessionIdentity } from "../src/shared/session-identity";

const identity: AuthSessionIdentity = {
	accountId: "account-a",
	sessionId: "session-a",
	generation: 1,
};

describe("ProactiveFeedbackRuntime", () => {
	test("keeps activation anonymous until the authenticated session is ready", async () => {
		const fixture = createFixture();
		const snapshot = await fixture.runtime.prepareSessionActivation(identity);
		expect(snapshot.policy).toEqual({ enabled: true, retention: 30 });
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		await fixture.runtime.sessionReady(identity);
		expect(fixture.calls.slice(-3)).toEqual([
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		expect(fixture.reflectionClearInputs).toEqual([]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBe("account-a");
		fixture.runtime.dispose();
	});

	test("disable commits first, cancels activity only, and clears every pending copy", async () => {
		const fixture = createFixture();
		await fixture.runtime.prepareSessionActivation(identity);
		fixture.calls.length = 0;
		const saved = await fixture.runtime.setPolicy(identity, {
			policy: { enabled: false, retention: 30 },
			expectedRevision: 0,
		});
		expect(saved.policy.enabled).toBe(false);
		expect(fixture.calls).toEqual([
			"save:false:30",
			"begin-reset:account-a",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:true",
			"discard:account-a",
			"clear-pending:account-a",
			"clear-reflection:account-a",
			"complete-reset:account-a",
			"cleanup:account-a",
		]);
		expect(fixture.reflectionClearInputs).toEqual([
			{ accountId: "account-a", requireCompletion: true },
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		fixture.runtime.dispose();
	});

	test("finishes durable disable cleanup after the exact session changes", async () => {
		const saveCommitted = deferred();
		const releaseSave = deferred();
		const fixture = createFixture({
			afterPolicySave: async () => {
				saveCommitted.resolve();
				await releaseSave.promise;
			},
		});
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		fixture.calls.length = 0;

		let failure: unknown = null;
		const pending = fixture.runtime
			.setPolicy(identity, {
				policy: { enabled: false, retention: 30 },
				expectedRevision: 0,
			})
			.catch((error) => {
				failure = error;
			});
		await saveCommitted.promise;
		fixture.current = {
			...identity,
			sessionId: "session-b",
			generation: 2,
		};
		releaseSave.resolve();
		await pending;

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("session changed");
		expect(fixture.calls).toEqual([
			"save:false:30",
			"begin-reset:account-a",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:true",
			"discard:account-a",
			"clear-pending:account-a",
			"clear-reflection:account-a",
			"complete-reset:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		fixture.runtime.dispose();
	});

	test("rejects a policy write when logout wins an in-flight policy read", async () => {
		const policyReadStarted = deferred();
		const releasePolicyRead = deferred();
		const fixture = createFixture({
			beforePolicyRead: async () => {
				policyReadStarted.resolve();
				await releasePolicyRead.promise;
			},
		});

		const request = fixture.runtime.setPolicy(identity, {
			policy: { enabled: true, retention: 7 },
			expectedRevision: 0,
		});
		await policyReadStarted.promise;
		fixture.current = null;
		releasePolicyRead.resolve();

		await expect(request).rejects.toThrow("session changed");
		expect(fixture.calls.some((call) => call.startsWith("save:"))).toBeFalse();
		fixture.runtime.dispose();
	});
});

function createFixture(initial?: {
	enabled?: boolean;
	revision?: number;
	capabilityAvailable?: boolean;
	accountCutoverFailures?: number;
	ensureAccountFailures?: number;
	afterEnsureAccount?: () => Promise<void>;
	isCurrentSessionFailure?: boolean;
	beforePolicyRead?: () => Promise<void>;
	afterPolicySave?: () => Promise<void>;
	failClearPendingOnce?: boolean;
	stopDelivery?: () => Promise<void>;
	startDeliveryFailures?: number;
	quiesceActivityRuns?: () => Promise<void>;
	discardActivityRuns?: () => Promise<void>;
	protectedRunIds?: readonly string[];
	clearPetPresentation?: () => Promise<void>;
	clearReflectionHandoffs?: (
		accountId: string,
		options?: { requireCompletion?: boolean },
	) => Promise<void>;
	cleanupProactiveFeedback?: () => Promise<void>;
	clearJournalPending?: boolean;
	pendingReset?: boolean;
}): {
	runtime: ProactiveFeedbackRuntime;
	calls: string[];
	current: AuthSessionIdentity | null;
	cleanupInputs: Array<{
		accountId: string;
		nowMs: number | undefined;
		protectedRunIds: readonly string[] | undefined;
	}>;
	errors: unknown[];
	reflectionClearInputs: Array<{
		accountId: string;
		requireCompletion: boolean;
	}>;
} {
	const calls: string[] = [];
	const errors: unknown[] = [];
	const reflectionClearInputs: Array<{
		accountId: string;
		requireCompletion: boolean;
	}> = [];
	const cleanupInputs: Array<{
		accountId: string;
		nowMs: number | undefined;
		protectedRunIds: readonly string[] | undefined;
	}> = [];
	let policy: ProactiveFeedbackPolicy = {
		enabled: initial?.enabled ?? true,
		retention: 30,
	};
	let revision = initial?.revision ?? 0;
	let accountCutoverFailures = initial?.accountCutoverFailures ?? 0;
	let ensureAccountFailures = initial?.ensureAccountFailures ?? 0;
	let failClearPendingOnce = initial?.failClearPendingOnce ?? false;
	let startDeliveryFailures = initial?.startDeliveryFailures ?? 0;
	let clearJournalPending = initial?.clearJournalPending ?? false;
	let pendingReset = initial?.pendingReset ?? false;
	const fixture = {
		runtime: null as unknown as ProactiveFeedbackRuntime,
		calls,
		current: { ...identity } as AuthSessionIdentity | null,
		cleanupInputs,
		errors,
		reflectionClearInputs,
	};
	const snapshot = (): ProactiveFeedbackPolicySnapshot => ({
		policy: { ...policy },
		revision,
		updatedAtMs: revision === 0 ? null : 1_000,
	});
	fixture.runtime = new ProactiveFeedbackRuntime({
		repository: {
			ensureAccount: async (accountId) => {
				calls.push(`ensure:${accountId}`);
				await initial?.afterEnsureAccount?.();
				if (ensureAccountFailures > 0) {
					ensureAccountFailures -= 1;
					throw new Error("account storage unavailable");
				}
			},
			getProactiveFeedbackPolicy: async () => {
				await initial?.beforePolicyRead?.();
				return snapshot();
			},
			setProactiveFeedbackPolicy: async (_accountId, next, expected) => {
				if (expected !== revision) throw new Error("revision conflict");
				policy = { ...next };
				revision += 1;
				calls.push(`save:${next.enabled}:${next.retention}`);
				await initial?.afterPolicySave?.();
				return snapshot();
			},
			listProactiveFeedback: async () => ({ items: [], nextCursor: null }),
			clearPendingProactiveFeedbackData: async (accountId) => {
				calls.push(`clear-pending:${accountId}`);
				if (failClearPendingOnce) {
					failClearPendingOnce = false;
					throw new Error("pending cleanup failed");
				}
			},
			beginProactiveFeedbackPendingReset: async (accountId) => {
				calls.push(`begin-reset:${accountId}`);
				pendingReset = true;
			},
			isProactiveFeedbackPendingReset: async () => pendingReset,
			completeProactiveFeedbackPendingReset: async (accountId) => {
				calls.push(`complete-reset:${accountId}`);
				pendingReset = false;
			},
			beginProactiveFeedbackClear: async (accountId) => {
				calls.push(`begin-clear:${accountId}`);
				clearJournalPending = true;
				pendingReset = false;
			},
			isProactiveFeedbackClearPending: async () => clearJournalPending,
			completeProactiveFeedbackClear: async (accountId) => {
				calls.push(`complete-clear:${accountId}`);
				clearJournalPending = false;
			},
			clearProactiveFeedbackData: async (accountId) => {
				calls.push(`clear-all:${accountId}`);
				return { clearedAtMs: 1_000 };
			},
			cleanupProactiveFeedback: async (accountId, nowMs, protectedRunIds) => {
				cleanupInputs.push({
					accountId,
					nowMs,
					protectedRunIds: protectedRunIds ? [...protectedRunIds] : undefined,
				});
				calls.push(`cleanup:${accountId}`);
				await initial?.cleanupProactiveFeedback?.();
			},
		},
		currentSession: () => (fixture.current ? { ...fixture.current } : null),
		isCurrentSession: (candidate) => {
			if (initial?.isCurrentSessionFailure) {
				throw new Error("session predicate unavailable");
			}
			return (
				fixture.current?.accountId === candidate.accountId &&
				fixture.current.sessionId === candidate.sessionId &&
				fixture.current.generation === candidate.generation
			);
		},
		isCapabilityAvailable: () => initial?.capabilityAvailable ?? true,
		cutoverCloudOwner: async (accountId) => {
			calls.push(`cutover:${accountId ?? "null"}`);
			if (accountId !== null && accountCutoverFailures > 0) {
				accountCutoverFailures -= 1;
				throw new Error("owner cutover failed");
			}
		},
		startDelivery: async () => {
			calls.push("start");
			if (startDeliveryFailures > 0) {
				startDeliveryFailures -= 1;
				throw new Error("delivery start failed");
			}
		},
		stopDelivery: async ({ accountId, clearPending }) => {
			calls.push(`stop:${accountId}:${clearPending}`);
			await initial?.stopDelivery?.();
		},
		abortActivityRequests: () => {
			calls.push("abort");
		},
		clearPetPresentation: async () => {
			calls.push("clear-pet");
			await initial?.clearPetPresentation?.();
		},
		quiesceActivityRuns: async (accountId) => {
			calls.push(`quiesce:${accountId}`);
			await initial?.quiesceActivityRuns?.();
		},
		discardActivityRuns: async (accountId) => {
			calls.push(`discard:${accountId}`);
			await initial?.discardActivityRuns?.();
		},
		clearReflectionHandoffs: async (accountId, options) => {
			calls.push(`clear-reflection:${accountId}`);
			reflectionClearInputs.push({
				accountId,
				requireCompletion: options?.requireCompletion === true,
			});
			await initial?.clearReflectionHandoffs?.(accountId, options);
		},
		protectedActivityRunIds: () => initial?.protectedRunIds ?? [],
		now: () => 1_000,
		setInterval: (() => 1) as unknown as typeof globalThis.setInterval,
		clearInterval: (() => {}) as typeof globalThis.clearInterval,
		onError: (error) => {
			errors.push(error);
		},
	});
	return fixture;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
