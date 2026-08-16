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

	test("repairs a crash after a disabled policy committed before pending cleanup", async () => {
		const fixture = createFixture({ enabled: false, revision: 1 });
		await fixture.runtime.prepareSessionActivation(identity);
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
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
		fixture.runtime.dispose();
	});

	test("session readiness repairs disabled cleanup after pre-activation storage failure", async () => {
		const fixture = createFixture({
			enabled: false,
			revision: 1,
			ensureAccountFailures: 1,
		});
		await fixture.runtime.prepareSessionActivationForAuth(identity);
		fixture.calls.length = 0;
		await fixture.runtime.sessionReady(identity);
		expect(fixture.calls).toContain("begin-reset:account-a");
		expect(fixture.calls).toContain("complete-reset:account-a");
		expect(fixture.calls).not.toContain("cutover:account-a");
		expect(fixture.calls).not.toContain("start");
		fixture.runtime.dispose();
	});

	test("a disabled-to-disabled retry repairs a failed cleanup barrier", async () => {
		const fixture = createFixture({ failClearPendingOnce: true });
		await fixture.runtime.prepareSessionActivation(identity);
		fixture.calls.length = 0;
		await expect(
			fixture.runtime.setPolicy(identity, {
				policy: { enabled: false, retention: 30 },
				expectedRevision: 0,
			}),
		).rejects.toThrow("pending cleanup failed");
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();

		fixture.calls.length = 0;
		const repaired = await fixture.runtime.setPolicy(identity, {
			policy: { enabled: false, retention: 30 },
			expectedRevision: 1,
		});
		expect(repaired.policy.enabled).toBeFalse();
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
			{ accountId: "account-a", requireCompletion: true },
		]);
		fixture.runtime.dispose();
	});

	test("does not attribute windows when model relay capability is absent", async () => {
		const fixture = createFixture({ capabilityAvailable: false });
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"begin-reset:account-a",
			"ensure:account-a",
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
		fixture.runtime.dispose();
	});

	test("recovers an incomplete capability reset before later delivery can start", async () => {
		const interrupted = createFixture({
			capabilityAvailable: false,
			clearReflectionHandoffs: async () => {
				throw new Error("reflection reset interrupted");
			},
		});
		await expect(
			interrupted.runtime.prepareSessionActivationForAuth(identity),
		).resolves.toBeUndefined();
		expect(interrupted.calls).toContain("begin-reset:account-a");
		expect(interrupted.calls).not.toContain("complete-reset:account-a");
		expect(interrupted.calls).not.toContain("start");
		interrupted.runtime.dispose();

		const recovered = createFixture({ pendingReset: true });
		await recovered.runtime.prepareSessionActivation(identity);
		await recovered.runtime.sessionReady(identity);
		const resetComplete = recovered.calls.indexOf("complete-reset:account-a");
		expect(resetComplete).toBeGreaterThanOrEqual(0);
		expect(recovered.calls.indexOf("cutover:account-a")).toBeGreaterThan(
			resetComplete,
		);
		expect(recovered.calls.indexOf("start")).toBeGreaterThan(resetComplete);
		recovered.runtime.dispose();
	});

	test("commits disabled consent before repairing an unavailable pending reset", async () => {
		let reflectionUnavailable = true;
		const fixture = createFixture({
			pendingReset: true,
			clearReflectionHandoffs: async () => {
				if (reflectionUnavailable) {
					throw new Error("reflection reset unavailable");
				}
			},
		});
		await expect(
			fixture.runtime.setPolicy(identity, {
				policy: { enabled: false, retention: 30 },
				expectedRevision: 0,
			}),
		).rejects.toThrow("reflection reset unavailable");
		await expect(fixture.runtime.getPolicy(identity)).resolves.toEqual(
			expect.objectContaining({
				policy: { enabled: false, retention: 30 },
				revision: 1,
			}),
		);

		reflectionUnavailable = false;
		fixture.calls.length = 0;
		await fixture.runtime.sessionReady(identity);
		expect(fixture.calls).toContain("complete-reset:account-a");
		expect(fixture.calls).not.toContain("start");
		fixture.runtime.dispose();
	});

	test("same-account replacement session quiesces the captured delivery", async () => {
		const fixture = createFixture();
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		fixture.calls.length = 0;
		const replacement = { ...identity, sessionId: "session-b", generation: 2 };
		await fixture.runtime.prepareSessionActivation(replacement);
		fixture.current = replacement;
		await fixture.runtime.sessionReady(replacement);
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		fixture.runtime.dispose();
	});

	test("drains the old session producer before quiescing its stable consumers", async () => {
		const stopStarted = deferred();
		const releaseStop = deferred();
		let blockStop = false;
		const fixture = createFixture({
			stopDelivery: async () => {
				if (!blockStop) return;
				stopStarted.resolve();
				await releaseStop.promise;
			},
		});
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		fixture.calls.length = 0;
		blockStop = true;
		const replacement = { ...identity, sessionId: "session-b", generation: 2 };
		const preparing = fixture.runtime.prepareSessionActivation(replacement);
		await stopStarted.promise;
		expect(fixture.calls).toContain("stop:account-a:false");
		expect(fixture.calls).not.toContain("quiesce:account-a");
		releaseStop.resolve();
		await preparing;
		expect(fixture.calls.indexOf("stop:account-a:false")).toBeLessThan(
			fixture.calls.indexOf("quiesce:account-a"),
		);
		fixture.runtime.dispose();
	});

	test("same-account replacement cannot publish its owner before pet clear settles", async () => {
		const clearStarted = deferred();
		const releaseClear = deferred();
		let blockClear = false;
		const fixture = createFixture({
			clearPetPresentation: async () => {
				if (!blockClear) return;
				clearStarted.resolve();
				await releaseClear.promise;
			},
		});
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);

		fixture.calls.length = 0;
		blockClear = true;
		const replacement = { ...identity, sessionId: "session-b", generation: 2 };
		let preparationSettled = false;
		const preparation = fixture.runtime
			.prepareSessionActivation(replacement)
			.finally(() => {
				preparationSettled = true;
			});
		await clearStarted.promise;

		fixture.current = replacement;
		let readinessSettled = false;
		const readiness = fixture.runtime.sessionReady(replacement).finally(() => {
			readinessSettled = true;
		});
		await Promise.resolve();

		expect(preparationSettled).toBe(false);
		expect(readinessSettled).toBe(false);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.calls).toEqual(["clear-pet"]);

		releaseClear.resolve();
		await preparation;
		await readiness;
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		fixture.runtime.dispose();
	});

	test("same-account replacement revokes old presentation before storage settles", async () => {
		const ensureStarted = deferred();
		const releaseEnsure = deferred();
		let blockEnsure = false;
		const fixture = createFixture({
			afterEnsureAccount: async () => {
				if (!blockEnsure) return;
				ensureStarted.resolve();
				await releaseEnsure.promise;
			},
		});
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBeTrue();

		fixture.calls.length = 0;
		blockEnsure = true;
		const replacement = { ...identity, sessionId: "session-b", generation: 2 };
		let settled = false;
		const preparation = fixture.runtime
			.prepareSessionActivation(replacement)
			.finally(() => {
				settled = true;
			});
		await ensureStarted.promise;

		expect(settled).toBeFalse();
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBeFalse();

		releaseEnsure.resolve();
		await preparation;
		fixture.runtime.dispose();
	});

	test("auth activation rejects when the pet privacy barrier cannot fail closed", async () => {
		let rejectClear = false;
		const fixture = createFixture({
			clearPetPresentation: async () => {
				if (rejectClear) throw new Error("pet clear and hide failed");
			},
		});
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		fixture.calls.length = 0;
		rejectClear = true;

		const replacement = { ...identity, sessionId: "session-b", generation: 2 };
		await expect(
			fixture.runtime.prepareSessionActivationForAuth(replacement),
		).rejects.toThrow("previous pet presentation");
		expect(fixture.calls).toEqual(["clear-pet"]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBeFalse();
		expect(fixture.errors).toHaveLength(1);
		fixture.runtime.dispose();
	});

	test("session readiness retries owner cutover without publishing a failed attempt", async () => {
		const fixture = createFixture({ accountCutoverFailures: 1 });
		await fixture.runtime.prepareSessionActivation(identity);
		fixture.calls.length = 0;

		await expect(fixture.runtime.sessionReady(identity)).rejects.toThrow(
			"owner cutover failed",
		);
		expect(fixture.calls).toEqual([
			"cutover:account-a",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBe(false);

		fixture.calls.length = 0;
		await fixture.runtime.sessionReady(identity);
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBe("account-a");
		fixture.runtime.dispose();
	});

	test("auth preparation contains storage failure without clearing durable pending work", async () => {
		const fixture = createFixture({ ensureAccountFailures: 1 });

		await expect(
			fixture.runtime.prepareSessionActivationForAuth(identity),
		).resolves.toBeUndefined();
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"cutover:null",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
		]);
		expect(fixture.calls).not.toContain("clear-pending:account-a");
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBeFalse();
		expect(fixture.errors).toHaveLength(1);
		fixture.runtime.dispose();
	});

	test("auth readiness replays a failed exact-session preparation barrier before starting", async () => {
		const readyStopStarted = deferred();
		const releaseReadyStop = deferred();
		let stopCalls = 0;
		let quiesceCalls = 0;
		const fixture = createFixture({
			ensureAccountFailures: 1,
			stopDelivery: async () => {
				stopCalls += 1;
				if (stopCalls === 1) throw new Error("fallback stop failed");
				readyStopStarted.resolve();
				await releaseReadyStop.promise;
			},
			quiesceActivityRuns: async () => {
				quiesceCalls += 1;
				if (quiesceCalls === 1) throw new Error("fallback quiesce failed");
			},
		});

		await expect(
			fixture.runtime.prepareSessionActivationForAuth(identity),
		).resolves.toBeUndefined();
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.calls).not.toContain("start");

		fixture.calls.length = 0;
		const readiness = fixture.runtime.sessionReadyForAuth(identity);
		await readyStopStarted.promise;
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"abort",
			"stop:account-a:false",
		]);
		expect(fixture.calls).not.toContain("cutover:account-a");
		expect(fixture.calls).not.toContain("start");

		releaseReadyStop.resolve();
		await readiness;
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBe("account-a");
		fixture.runtime.dispose();
	});

	test("a queued old-session callback cannot cross a newer preparation latch", async () => {
		const cleanupStarted = deferred();
		const releaseCleanup = deferred();
		let blockCleanup = false;
		const fixture = createFixture({
			cleanupProactiveFeedback: async () => {
				if (!blockCleanup) return;
				cleanupStarted.resolve();
				await releaseCleanup.promise;
			},
		});
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		fixture.calls.length = 0;

		blockCleanup = true;
		const blockingCleanup = fixture.runtime.cleanupCurrentAccount();
		await cleanupStarted.promise;
		const replacement = { ...identity, sessionId: "session-b", generation: 2 };
		const preparation = fixture.runtime.prepareSessionActivation(replacement);
		const staleReadiness = fixture.runtime.sessionReady(identity);
		releaseCleanup.resolve();
		await blockingCleanup;
		await preparation;
		await staleReadiness;

		expect(fixture.calls).toEqual([
			"cleanup:account-a",
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBeFalse();
		await expect(
			fixture.runtime.setPolicy(identity, {
				policy: { enabled: true, retention: 90 },
				expectedRevision: 0,
			}),
		).rejects.toThrow("superseded");

		fixture.current = replacement;
		fixture.calls.length = 0;
		await fixture.runtime.sessionReady(replacement);
		expect(fixture.calls).toEqual([
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		fixture.runtime.dispose();
	});

	test("auth readiness contains owner cutover failure without revoking login", async () => {
		const fixture = createFixture({ accountCutoverFailures: 1 });
		await fixture.runtime.prepareSessionActivation(identity);
		fixture.calls.length = 0;

		await expect(
			fixture.runtime.sessionReadyForAuth(identity),
		).resolves.toBeUndefined();
		expect(fixture.calls).toEqual([
			"cutover:account-a",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBeFalse();
		expect(fixture.errors).toHaveLength(1);
		fixture.runtime.dispose();
	});

	test("auth adapter contains failures in its own fail-closed fallback", async () => {
		const fixture = createFixture({
			isCurrentSessionFailure: true,
		});

		await expect(
			fixture.runtime.sessionReadyForAuth(identity),
		).resolves.toBeUndefined();
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.errors.length).toBeGreaterThanOrEqual(2);
		fixture.runtime.dispose();
	});

	test("suppresses terminal presentation across disable and clear epochs", async () => {
		const fixture = createFixture();
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		expect(fixture.runtime.isPresentationAllowed(identity, 1_000)).toBe(false);
		expect(fixture.runtime.isPresentationAllowed(identity, 1_001)).toBe(true);
		await fixture.runtime.setPolicy(identity, {
			policy: { enabled: false, retention: 30 },
			expectedRevision: 0,
		});
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBe(false);
		fixture.runtime.dispose();
	});

	test("awaits pet clearing after revoking presentation on disable", async () => {
		const petClear = deferred();
		const petClearStarted = deferred();
		let petClearCalls = 0;
		const fixture = createFixture({
			clearPetPresentation: async () => {
				petClearCalls += 1;
				if (petClearCalls === 1) return;
				petClearStarted.resolve();
				await petClear.promise;
			},
		});
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		fixture.calls.length = 0;
		const disabling = fixture.runtime.setPolicy(identity, {
			policy: { enabled: false, retention: 30 },
			expectedRevision: 0,
		});
		await petClearStarted.promise;
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBe(false);
		expect(fixture.calls).toContain("clear-pet");
		expect(fixture.calls).not.toContain("cutover:null");
		petClear.resolve();
		await disabling;
		fixture.runtime.dispose();
	});

	test("clear uses an anonymous epoch and restarts only for the same enabled session", async () => {
		const fixture = createFixture();
		await fixture.runtime.prepareSessionActivation(identity);
		fixture.calls.length = 0;
		await fixture.runtime.clearData(identity);
		expect(fixture.calls).toEqual([
			"begin-clear:account-a",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:true",
			"discard:account-a",
			"clear-reflection:account-a",
			"clear-all:account-a",
			"complete-clear:account-a",
			"cutover:account-a",
			"start",
		]);
		expect(fixture.reflectionClearInputs).toEqual([
			{ accountId: "account-a", requireCompletion: true },
		]);
		fixture.runtime.dispose();
	});

	test("promotes an incomplete pending reset directly into the full clear", async () => {
		const fixture = createFixture({ pendingReset: true });
		await fixture.runtime.clearData(identity);
		expect(fixture.calls[0]).toBe("begin-clear:account-a");
		expect(fixture.calls).not.toContain("clear-pending:account-a");
		expect(fixture.calls).not.toContain("complete-reset:account-a");
		expect(fixture.calls).toContain("complete-clear:account-a");
		fixture.runtime.dispose();
	});

	test("clear drains the activity producer before cancelling the stable consumer set", async () => {
		const stopStarted = deferred();
		const releaseStop = deferred();
		let producerStopped = false;
		const fixture = createFixture({
			stopDelivery: async () => {
				stopStarted.resolve();
				await releaseStop.promise;
				producerStopped = true;
			},
			discardActivityRuns: async () => {
				expect(producerStopped).toBeTrue();
			},
		});

		const clearing = fixture.runtime.clearData(identity);
		await stopStarted.promise;
		expect(fixture.calls).not.toContain("discard:account-a");
		releaseStop.resolve();
		await clearing;
		expect(fixture.calls.indexOf("stop:account-a:true")).toBeLessThan(
			fixture.calls.indexOf("discard:account-a"),
		);
		fixture.runtime.dispose();
	});

	test("never reports user data clearing as successful before Reflection handoffs are confirmed", async () => {
		const fixture = createFixture({
			clearReflectionHandoffs: async (_accountId, options) => {
				if (options?.requireCompletion === true) {
					throw new Error("reflection runtime unavailable");
				}
			},
		});

		await expect(fixture.runtime.clearData(identity)).rejects.toThrow(
			"reflection runtime unavailable",
		);
		expect(fixture.calls).toContain("clear-all:account-a");
		expect(fixture.calls).not.toContain("complete-clear:account-a");
		fixture.calls.length = 0;
		await expect(fixture.runtime.sessionReady(identity)).rejects.toThrow(
			"reflection runtime unavailable",
		);
		expect(fixture.calls).not.toContain("cutover:account-a");
		expect(fixture.calls).not.toContain("start");
		expect(fixture.reflectionClearInputs).toEqual([
			{ accountId: "account-a", requireCompletion: true },
			{ accountId: "account-a", requireCompletion: true },
		]);
		fixture.runtime.dispose();
	});

	test("recovers a durable clear journal before restart may reactivate delivery", async () => {
		const fixture = createFixture({ clearJournalPending: true });

		await fixture.runtime.prepareSessionActivation(identity);
		expect(fixture.calls).toContain("complete-clear:account-a");
		expect(fixture.calls).not.toContain("cutover:account-a");
		expect(fixture.calls).not.toContain("start");
		const completedIndex = fixture.calls.indexOf("complete-clear:account-a");

		await fixture.runtime.sessionReady(identity);
		expect(fixture.calls.indexOf("cutover:account-a")).toBeGreaterThan(
			completedIndex,
		);
		expect(fixture.calls.indexOf("start")).toBeGreaterThan(completedIndex);
		fixture.runtime.dispose();
	});

	test("re-enable clears disabled-interval handoffs before committing the policy", async () => {
		const fixture = createFixture({ enabled: false, revision: 1 });
		await fixture.runtime.setPolicy(identity, {
			policy: { enabled: true, retention: 30 },
			expectedRevision: 1,
		});
		expect(fixture.calls).toEqual([
			"begin-reset:account-a",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:true",
			"discard:account-a",
			"clear-pending:account-a",
			"clear-reflection:account-a",
			"complete-reset:account-a",
			"save:true:30",
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		expect(fixture.reflectionClearInputs).toEqual([
			{ accountId: "account-a", requireCompletion: true },
		]);
		fixture.runtime.dispose();
	});

	test("does not re-enable before repairing an incomplete disabled cleanup", async () => {
		const fixture = createFixture({
			enabled: false,
			revision: 1,
			failClearPendingOnce: true,
		});
		await expect(
			fixture.runtime.setPolicy(identity, {
				policy: { enabled: true, retention: 30 },
				expectedRevision: 1,
			}),
		).rejects.toThrow("pending cleanup failed");
		expect(fixture.calls).not.toContain("save:true:30");
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();

		fixture.calls.length = 0;
		await fixture.runtime.setPolicy(identity, {
			policy: { enabled: true, retention: 30 },
			expectedRevision: 1,
		});
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:true",
			"discard:account-a",
			"clear-pending:account-a",
			"clear-reflection:account-a",
			"complete-reset:account-a",
			"save:true:30",
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		fixture.runtime.dispose();
	});

	test("re-enable republishes only after a failed owner cutover is retried", async () => {
		const fixture = createFixture({
			enabled: false,
			revision: 1,
			accountCutoverFailures: 1,
		});
		await expect(
			fixture.runtime.setPolicy(identity, {
				policy: { enabled: true, retention: 30 },
				expectedRevision: 1,
			}),
		).rejects.toThrow("owner cutover failed");
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBe(false);

		fixture.calls.length = 0;
		await fixture.runtime.setPolicy(identity, {
			policy: { enabled: true, retention: 30 },
			expectedRevision: 2,
		});
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
			"save:true:30",
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBe("account-a");
		fixture.runtime.dispose();
	});

	test("a partial delivery start is fail closed and retried behind a fresh barrier", async () => {
		const fixture = createFixture({
			enabled: false,
			revision: 1,
			startDeliveryFailures: 1,
		});
		await expect(
			fixture.runtime.setPolicy(identity, {
				policy: { enabled: true, retention: 30 },
				expectedRevision: 1,
			}),
		).rejects.toThrow("delivery start failed");
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBeFalse();
		expect(fixture.calls.slice(-6)).toEqual([
			"start",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
		]);

		fixture.calls.length = 0;
		await fixture.runtime.setPolicy(identity, {
			policy: { enabled: true, retention: 90 },
			expectedRevision: 2,
		});
		expect(fixture.calls).toEqual([
			"clear-pet",
			"cutover:null",
			"ensure:account-a",
			"abort",
			"stop:account-a:false",
			"quiesce:account-a",
			"save:true:90",
			"cutover:account-a",
			"start",
			"cleanup:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBe("account-a");
		fixture.runtime.dispose();
	});

	test("clear-data retry does not publish an owner before cutover succeeds", async () => {
		const fixture = createFixture({ accountCutoverFailures: 1 });
		await expect(fixture.runtime.clearData(identity)).rejects.toThrow(
			"owner cutover failed",
		);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		expect(fixture.runtime.isPresentationAllowed(identity, 9_999)).toBe(false);

		fixture.calls.length = 0;
		await fixture.runtime.clearData(identity);
		expect(fixture.calls).toEqual([
			"begin-clear:account-a",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:true",
			"discard:account-a",
			"clear-reflection:account-a",
			"clear-all:account-a",
			"complete-clear:account-a",
			"cutover:account-a",
			"start",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBe("account-a");
		fixture.runtime.dispose();
	});

	test("clear finishes every account-bound erasure step after the session changes", async () => {
		const cancelStarted = deferred();
		const releaseCancel = deferred();
		const fixture = createFixture({
			discardActivityRuns: async () => {
				cancelStarted.resolve();
				await releaseCancel.promise;
				throw new Error("old session cancellation failed");
			},
		});
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);
		fixture.calls.length = 0;

		const clearing = fixture.runtime.clearData(identity);
		await cancelStarted.promise;
		fixture.current = {
			...identity,
			sessionId: "session-b",
			generation: 2,
		};
		releaseCancel.resolve();
		await expect(clearing).rejects.toThrow("old session cancellation failed");
		expect(fixture.calls).toEqual([
			"begin-clear:account-a",
			"clear-pet",
			"cutover:null",
			"abort",
			"stop:account-a:true",
			"discard:account-a",
			"quiesce:account-a",
			"clear-reflection:account-a",
			"clear-all:account-a",
		]);
		expect(fixture.runtime.cloudOwnerAccountId()).toBeNull();
		fixture.runtime.dispose();
	});

	test("rejects a stale enable revision before any owner or handoff side effect", async () => {
		const fixture = createFixture({ enabled: false, revision: 2 });
		await expect(
			fixture.runtime.setPolicy(identity, {
				policy: { enabled: true, retention: 30 },
				expectedRevision: 1,
			}),
		).rejects.toMatchObject({ actualRevision: 2, expectedRevision: 1 });
		expect(fixture.calls).toEqual([]);
		fixture.runtime.dispose();
	});

	test("a session transition fails closed before reading another account", async () => {
		const fixture = createFixture();
		fixture.current = null;
		await expect(fixture.runtime.list(identity, {})).rejects.toThrow(
			"session changed",
		);
		expect(fixture.calls).toEqual([]);
		fixture.runtime.dispose();
	});

	test("passes Worker phase-two run protection into retention cleanup", async () => {
		const fixture = createFixture({
			protectedRunIds: ["activity-run-awaiting-phase-two"],
		});
		await fixture.runtime.prepareSessionActivation(identity);
		await fixture.runtime.sessionReady(identity);

		expect(fixture.cleanupInputs).toEqual([
			{
				accountId: "account-a",
				nowMs: 1_000,
				protectedRunIds: ["activity-run-awaiting-phase-two"],
			},
		]);
		fixture.runtime.dispose();
	});

	test("shutdown rejects new work and drains the accepted serial tail", async () => {
		const cleanupStarted = deferred();
		const releaseCleanup = deferred();
		const fixture = createFixture({
			cleanupProactiveFeedback: async () => {
				cleanupStarted.resolve();
				await releaseCleanup.promise;
			},
		});
		await fixture.runtime.prepareSessionActivation(identity);
		const readiness = fixture.runtime.sessionReady(identity);
		await cleanupStarted.promise;

		let drained = false;
		const shutdown = fixture.runtime.shutdown().then(() => {
			drained = true;
		});
		await expect(fixture.runtime.getPolicy(identity)).rejects.toThrow(
			"shutting down",
		);
		await Promise.resolve();
		expect(drained).toBeFalse();

		releaseCleanup.resolve();
		await readiness;
		await shutdown;
		expect(drained).toBeTrue();
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
