import type {
	ClearProactiveFeedbackResult,
	ListProactiveFeedbackRequest,
	ProactiveFeedbackPage,
	ProactiveFeedbackPolicySnapshot,
	SetProactiveFeedbackPolicyRequest,
} from "../shared/proactive-feedback";
import type { AuthSessionIdentity } from "../shared/session-identity";
import { ProactiveFeedbackPolicyRevisionConflictError } from "./encrypted-agent-repository";

const DAY_MS = 24 * 60 * 60 * 1_000;

class ProactiveFeedbackPetBarrierError extends Error {
	readonly originalError: unknown;

	constructor(originalError: unknown) {
		super("The previous pet presentation could not be cleared safely.");
		this.name = "ProactiveFeedbackPetBarrierError";
		this.originalError = originalError;
	}
}

class ProactiveFeedbackOwnerBarrierError extends Error {
	readonly originalError: unknown;

	constructor(originalError: unknown) {
		super("The previous proactive feedback owner could not be revoked safely.");
		this.name = "ProactiveFeedbackOwnerBarrierError";
		this.originalError = originalError;
	}
}

export interface ProactiveFeedbackRuntimeRepository {
	ensureAccount(accountId: string): Promise<void>;
	getProactiveFeedbackPolicy(
		accountId: string,
	): Promise<ProactiveFeedbackPolicySnapshot>;
	setProactiveFeedbackPolicy(
		accountId: string,
		policy: SetProactiveFeedbackPolicyRequest["policy"],
		expectedRevision: number,
	): Promise<ProactiveFeedbackPolicySnapshot>;
	listProactiveFeedback(
		accountId: string,
		request: ListProactiveFeedbackRequest,
	): Promise<ProactiveFeedbackPage>;
	clearPendingProactiveFeedbackData(accountId: string): Promise<unknown>;
	beginProactiveFeedbackPendingReset(accountId: string): Promise<void>;
	isProactiveFeedbackPendingReset(accountId: string): Promise<boolean>;
	completeProactiveFeedbackPendingReset(accountId: string): Promise<void>;
	beginProactiveFeedbackClear(accountId: string): Promise<void>;
	isProactiveFeedbackClearPending(accountId: string): Promise<boolean>;
	completeProactiveFeedbackClear(accountId: string): Promise<void>;
	clearProactiveFeedbackData(
		accountId: string,
	): Promise<ClearProactiveFeedbackResult>;
	cleanupProactiveFeedback(
		accountId: string,
		nowMs?: number,
		protectedRunIds?: readonly string[],
	): Promise<unknown>;
}

export interface ProactiveFeedbackRuntimeOptions {
	repository: ProactiveFeedbackRuntimeRepository;
	currentSession(): AuthSessionIdentity | null;
	isCurrentSession(identity: AuthSessionIdentity): boolean;
	isCapabilityAvailable(): boolean;
	cutoverCloudOwner(accountId: string | null): Promise<void>;
	startDelivery(): Promise<void>;
	stopDelivery(input: {
		accountId: string;
		clearPending: boolean;
	}): Promise<void>;
	abortActivityRequests(): void;
	clearPetPresentation(): Promise<void>;
	quiesceActivityRuns(accountId: string): Promise<void>;
	discardActivityRuns(accountId: string): Promise<void>;
	clearReflectionHandoffs(
		accountId: string,
		options?: { requireCompletion?: boolean },
	): Promise<unknown>;
	protectedActivityRunIds(accountId: string): readonly string[];
	now?: () => number;
	setInterval?: typeof globalThis.setInterval;
	clearInterval?: typeof globalThis.clearInterval;
	onError?: (error: unknown) => void;
}

/**
 * Serializes every policy/owner transition. Policy is committed before a
 * disable barrier, so late model completions fail closed in the repository;
 * enablement cuts a fresh durable owner epoch before delivery can start.
 */
export class ProactiveFeedbackRuntime {
	private readonly repository: ProactiveFeedbackRuntimeRepository;
	private readonly currentSession: () => AuthSessionIdentity | null;
	private readonly isCurrentSession: (identity: AuthSessionIdentity) => boolean;
	private readonly isCapabilityAvailable: () => boolean;
	private readonly cutoverCloudOwner: (
		accountId: string | null,
	) => Promise<void>;
	private readonly startDelivery: () => Promise<void>;
	private readonly stopDelivery: ProactiveFeedbackRuntimeOptions["stopDelivery"];
	private readonly abortActivityRequests: () => void;
	private readonly clearPetPresentation: () => Promise<void>;
	private readonly quiesceActivityRuns: (accountId: string) => Promise<void>;
	private readonly discardActivityRuns: (accountId: string) => Promise<void>;
	private readonly clearReflectionHandoffs: (
		accountId: string,
		options?: { requireCompletion?: boolean },
	) => Promise<unknown>;
	private readonly protectedActivityRunIds: (
		accountId: string,
	) => readonly string[];
	private readonly now: () => number;
	private readonly clearInterval: typeof globalThis.clearInterval;
	private readonly onError: (error: unknown) => void;
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private desiredOwnerAccountId: string | null = null;
	private presentationOwner: AuthSessionIdentity | null = null;
	private activationCandidateIdentity: AuthSessionIdentity | null = null;
	private preparedSessionIdentity: AuthSessionIdentity | null = null;
	private presentationNotBeforeMs = Number.POSITIVE_INFINITY;
	private readonly resetSatisfiedAccounts = new Set<string>();
	private readonly cleanupTimer: ReturnType<typeof globalThis.setInterval>;

	constructor(options: ProactiveFeedbackRuntimeOptions) {
		this.repository = options.repository;
		this.currentSession = options.currentSession;
		this.isCurrentSession = options.isCurrentSession;
		this.isCapabilityAvailable = options.isCapabilityAvailable;
		this.cutoverCloudOwner = options.cutoverCloudOwner;
		this.startDelivery = options.startDelivery;
		this.stopDelivery = options.stopDelivery;
		this.abortActivityRequests = options.abortActivityRequests;
		this.clearPetPresentation = options.clearPetPresentation;
		this.quiesceActivityRuns = options.quiesceActivityRuns;
		this.discardActivityRuns = options.discardActivityRuns;
		this.clearReflectionHandoffs = options.clearReflectionHandoffs;
		this.protectedActivityRunIds = options.protectedActivityRunIds;
		this.now = options.now ?? Date.now;
		const schedule = options.setInterval ?? globalThis.setInterval;
		this.clearInterval = options.clearInterval ?? globalThis.clearInterval;
		this.onError = options.onError ?? (() => {});
		this.cleanupTimer = schedule(() => {
			void this.cleanupCurrentAccount().catch((error) => this.report(error));
		}, DAY_MS);
	}

	cloudOwnerAccountId(): string | null {
		return this.desiredOwnerAccountId;
	}

	isPresentationAllowed(
		identity: AuthSessionIdentity,
		generatedAtMs: number,
	): boolean {
		const owner = this.presentationOwner;
		return (
			owner !== null &&
			sameIdentity(this.activationCandidateIdentity, identity) &&
			sameIdentity(this.preparedSessionIdentity, identity) &&
			owner.accountId === identity.accountId &&
			owner.sessionId === identity.sessionId &&
			owner.generation === identity.generation &&
			this.isCurrentSession(identity) &&
			this.isCapabilityAvailable() &&
			generatedAtMs >= this.presentationNotBeforeMs
		);
	}

	async prepareSessionActivation(
		identity: AuthSessionIdentity,
	): Promise<ProactiveFeedbackPolicySnapshot> {
		return this.serial(() => this.prepareSessionActivationInSerial(identity));
	}

	private async prepareSessionActivationInSerial(
		identity: AuthSessionIdentity,
	): Promise<ProactiveFeedbackPolicySnapshot> {
		// This exact-identity latch is published only after the complete producer
		// and consumer barrier succeeds. The auth adapter is allowed to contain an
		// optional preparation failure, so sessionReady() must be able to prove
		// whether it needs to replay the barrier after the session is published.
		this.activationCandidateIdentity = structuredClone(identity);
		this.preparedSessionIdentity = null;
		// Revoke presentation synchronously, then prove the old renderer is clear
		// and the durable Reflection owner is anonymous before any storage or
		// capability await. A same-account refresh does not run the ordinary
		// account-clear hook, so both critical privacy barriers must finish before
		// RemoteAuth may publish the new identity.
		this.revokeOwner();
		await this.clearPetActivationBarrier();
		await this.clearCloudOwnerActivationBarrier();
		const capabilityAvailable = this.isCapabilityAvailable();
		if (!capabilityAvailable) {
			// Establish the crash journal before a Keychain-backed account read. For
			// an existing account this needs no key material, so a temporary key
			// outage cannot let old Reflection windows escape a capability-loss reset.
			await this.repository.beginProactiveFeedbackPendingReset(
				identity.accountId,
			);
		}
		await this.repository.ensureAccount(identity.accountId);
		let resetRepaired = false;
		if (
			await this.repository.isProactiveFeedbackClearPending(identity.accountId)
		) {
			await this.finishPendingClear(identity);
		}
		if (
			await this.repository.isProactiveFeedbackPendingReset(identity.accountId)
		) {
			await this.finishPendingReset(identity);
			resetRepaired = true;
		}
		const snapshot = await this.repository.getProactiveFeedbackPolicy(
			identity.accountId,
		);
		const eligible = snapshot.policy.enabled && capabilityAvailable;
		if (!eligible) {
			if (!resetRepaired) {
				await this.repository.beginProactiveFeedbackPendingReset(
					identity.accountId,
				);
				await this.finishPendingReset(identity);
			}
			this.preparedSessionIdentity = structuredClone(identity);
			return snapshot;
		}
		// Every activation, including a same-account session rotation, is an
		// exact-session barrier. Drain the producer before quiescing the stable
		// consumer set so no dispatcher start can enter between the two steps.
		this.abortActivityRequests();
		await this.stopDelivery({
			accountId: identity.accountId,
			clearPending: false,
		});
		await this.quiesceActivityRuns(identity.accountId);
		this.preparedSessionIdentity = structuredClone(identity);
		return snapshot;
	}

	/**
	 * Auth lifecycle adapter. Proactive feedback is optional: a local storage,
	 * cutover, or delivery failure must leave this subsystem anonymous and
	 * quiesced without rejecting an otherwise valid remote login.
	 */
	async prepareSessionActivationForAuth(
		identity: AuthSessionIdentity,
	): Promise<void> {
		try {
			await this.prepareSessionActivation(identity);
		} catch (error) {
			if (error instanceof ProactiveFeedbackPetBarrierError) {
				this.report(error.originalError);
				throw error;
			}
			// prepareSessionActivation always completes its critical Pet barrier before
			// it can reach an optional storage/cutover operation, so this containment
			// path must not perform a second, availability-coupled renderer clear.
			await this.failClosedAfterAuthFailure(identity, error, false);
		}
	}

	async clearSessionOwner(): Promise<void> {
		await this.serial(async () => {
			this.activationCandidateIdentity = null;
			this.preparedSessionIdentity = null;
			this.revokeOwner();
			const failures: unknown[] = [];
			try {
				await this.clearPetPresentation();
			} catch (error) {
				failures.push(error);
			}
			try {
				await this.cutoverCloudOwner(null);
			} catch (error) {
				failures.push(error);
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(
					failures,
					"The proactive owner and pet presentation could not both be cleared.",
				);
			}
		});
	}

	async sessionReady(identity: AuthSessionIdentity): Promise<void> {
		await this.serial(async () => {
			this.assertSession(identity);
			if (
				this.activationCandidateIdentity !== null &&
				!sameIdentity(this.activationCandidateIdentity, identity)
			) {
				// A newer activation completed its pre-publication barrier while this
				// readiness callback waited on the serial tail. It is stale even if the
				// old RemoteAuth identity has not yet been replaced synchronously.
				return;
			}
			if (!sameIdentity(this.preparedSessionIdentity, identity)) {
				// Startup recovery and a contained auth-preparation failure both arrive
				// here without a successful exact-session barrier. Replay the complete
				// barrier in this same serialized state transition before publication.
				await this.prepareSessionActivationInSerial(identity);
				this.assertSession(identity);
			}
			if (
				await this.repository.isProactiveFeedbackClearPending(
					identity.accountId,
				)
			) {
				await this.finishPendingClear(identity);
				this.assertSession(identity);
			}
			if (
				await this.repository.isProactiveFeedbackPendingReset(
					identity.accountId,
				)
			) {
				await this.finishPendingReset(identity);
				this.assertSession(identity);
			}
			const snapshot = await this.repository.getProactiveFeedbackPolicy(
				identity.accountId,
			);
			const eligible = snapshot.policy.enabled && this.isCapabilityAvailable();
			if (!eligible && !this.resetSatisfiedAccounts.has(identity.accountId)) {
				await this.repository.beginProactiveFeedbackPendingReset(
					identity.accountId,
				);
				await this.finishPendingReset(identity);
				this.assertSession(identity);
			}
			if (eligible) {
				const needsOwnerPublication =
					this.desiredOwnerAccountId !== identity.accountId ||
					!sameIdentity(this.presentationOwner, identity);
				await this.activateOwnerAndStartDelivery(
					identity,
					needsOwnerPublication,
				);
			}
			this.assertSession(identity);
			await this.cleanupAccount(identity.accountId);
		});
	}

	/** Post-publication counterpart to prepareSessionActivationForAuth(). */
	async sessionReadyForAuth(identity: AuthSessionIdentity): Promise<void> {
		try {
			await this.sessionReady(identity);
		} catch (error) {
			await this.failClosedAfterAuthFailure(identity, error, true);
		}
	}

	async getPolicy(
		identity: AuthSessionIdentity,
	): Promise<ProactiveFeedbackPolicySnapshot> {
		return this.serial(async () => {
			this.assertSession(identity);
			return this.repository.getProactiveFeedbackPolicy(identity.accountId);
		});
	}

	async setPolicy(
		identity: AuthSessionIdentity,
		request: SetProactiveFeedbackPolicyRequest,
	): Promise<ProactiveFeedbackPolicySnapshot> {
		return this.serial(async () => {
			this.assertSession(identity);
			this.assertActivationCandidate(identity);
			let resetRepaired = false;
			if (
				await this.repository.isProactiveFeedbackClearPending(
					identity.accountId,
				)
			) {
				await this.finishPendingClear(identity);
				this.assertSession(identity);
			}
			const before = await this.repository.getProactiveFeedbackPolicy(
				identity.accountId,
			);
			if (before.revision !== request.expectedRevision) {
				throw new ProactiveFeedbackPolicyRevisionConflictError(
					request.expectedRevision,
					before.revision,
				);
			}
			if (
				request.policy.enabled &&
				before.policy.enabled &&
				!sameIdentity(this.preparedSessionIdentity, identity)
			) {
				await this.prepareSessionActivationInSerial(identity);
				this.assertSession(identity);
			}
			const pendingReset =
				await this.repository.isProactiveFeedbackPendingReset(
					identity.accountId,
				);
			// Disabling consent must commit before an optional cross-store repair.
			// For every enabled target, finish the durable reset first so no old
			// evidence can become eligible under the saved policy.
			if (pendingReset && request.policy.enabled) {
				await this.finishPendingReset(identity);
				this.assertSession(identity);
				this.markPreparedAfterStrongBarrier(identity);
				resetRepaired = true;
			}
			const enabling = !before.policy.enabled && request.policy.enabled;
			const disabling = before.policy.enabled && !request.policy.enabled;
			if (enabling && !resetRepaired) await this.prepareEnable(identity);
			// This is the write linearization gate: every asynchronous read, repair,
			// and enable preparation has completed, and no await may separate these
			// exact-session checks from invoking the repository write.
			this.assertSession(identity);
			this.assertActivationCandidate(identity);
			if (disabling) {
				// Revoke presentation synchronously before yielding to the policy write.
				// A completion already committed in SQLite but awaiting its callback must
				// not repaint the pet/history event after the user turned the feature off.
				this.presentationOwner = null;
				this.presentationNotBeforeMs = Number.POSITIVE_INFINITY;
			}
			let saved: ProactiveFeedbackPolicySnapshot;
			try {
				saved = await this.repository.setProactiveFeedbackPolicy(
					identity.accountId,
					request.policy,
					request.expectedRevision,
				);
			} catch (error) {
				if (enabling) {
					this.desiredOwnerAccountId = null;
					this.presentationOwner = null;
					this.presentationNotBeforeMs = Number.POSITIVE_INFINITY;
					await this.cutoverCloudOwner(null).catch(() => undefined);
				} else if (
					disabling &&
					this.isCurrentSession(identity) &&
					sameIdentity(this.activationCandidateIdentity, identity) &&
					sameIdentity(this.preparedSessionIdentity, identity) &&
					this.desiredOwnerAccountId === identity.accountId
				) {
					this.presentationOwner = structuredClone(identity);
					this.presentationNotBeforeMs = this.now() + 1;
				}
				throw error;
			}
			// A durable disabled policy is itself the recovery journal. Re-enforce
			// every account-bound cleanup even on a false -> false retry so a prior
			// crash or transient stop/storage failure cannot leave pending work live.
			if (!saved.policy.enabled) {
				if (!resetRepaired) await this.disableAccount(identity);
				this.assertSession(identity);
			} else {
				this.assertSession(identity);
				const needsActivation =
					saved.policy.enabled &&
					this.isCapabilityAvailable() &&
					(this.desiredOwnerAccountId !== identity.accountId ||
						!sameIdentity(this.presentationOwner, identity));
				if (needsActivation) {
					await this.activateOwnerAndStartDelivery(identity);
				}
			}
			this.assertSession(identity);
			await this.cleanupAccount(identity.accountId);
			return saved;
		});
	}

	async list(
		identity: AuthSessionIdentity,
		request: ListProactiveFeedbackRequest,
	): Promise<ProactiveFeedbackPage> {
		return this.serial(async () => {
			this.assertSession(identity);
			if (
				await this.repository.isProactiveFeedbackClearPending(
					identity.accountId,
				)
			) {
				throw new Error("Proactive feedback data clearing is still pending.");
			}
			const page = await this.repository.listProactiveFeedback(
				identity.accountId,
				request,
			);
			this.assertSession(identity);
			return page;
		});
	}

	async clearData(
		identity: AuthSessionIdentity,
	): Promise<ClearProactiveFeedbackResult> {
		return this.serial(async () => {
			this.assertSession(identity);
			this.assertActivationCandidate(identity);
			// This journal is the privacy boundary across process exit. It is written
			// before any destructive side effect and removed only after every local and
			// Reflection copy has been confirmed clear. begin atomically promotes an
			// unfinished pending reset, so the user's stronger erasure intent never
			// passes through an unjournaled crash window.
			this.revokeOwner();
			await this.repository.beginProactiveFeedbackClear(identity.accountId);
			const result = await this.finishPendingClear(identity);
			if (!this.isCurrentSession(identity)) return result;
			this.assertActivationCandidate(identity);
			this.markPreparedAfterStrongBarrier(identity);
			const current = await this.repository.getProactiveFeedbackPolicy(
				identity.accountId,
			);
			if (current.policy.enabled && this.isCapabilityAvailable()) {
				await this.activateOwnerAndStartDelivery(identity);
			}
			return result;
		});
	}

	async cleanupCurrentAccount(): Promise<void> {
		await this.serial(async () => {
			const identity = this.currentSession();
			if (!identity) return;
			this.assertActivationCandidate(identity);
			await this.cleanupAccount(identity.accountId);
			this.assertSession(identity);
		});
	}

	dispose(): void {
		this.closed = true;
		this.clearInterval(this.cleanupTimer);
	}

	/** Stops future work and drains every operation already accepted by serial(). */
	async shutdown(): Promise<void> {
		this.dispose();
		await this.tail;
	}

	private async disableAccount(identity: AuthSessionIdentity): Promise<void> {
		await this.repository.beginProactiveFeedbackPendingReset(
			identity.accountId,
		);
		await this.finishPendingReset(identity);
	}

	private async finishPendingReset(
		identity: AuthSessionIdentity,
	): Promise<void> {
		this.revokeOwner();
		let cleanupFailure: unknown = null;
		const attempt = async (
			operation: () => Promise<unknown>,
		): Promise<void> => {
			try {
				await operation();
			} catch (error) {
				cleanupFailure ??= error;
			}
		};

		await attempt(() => this.clearPetPresentation());
		await attempt(() => this.cutoverCloudOwner(null));
		try {
			this.abortActivityRequests();
		} catch (error) {
			cleanupFailure ??= error;
		}
		// Stop and drain the durable producer before taking the coordinator
		// snapshot. Otherwise a queued dispatcher wake could create a new run in
		// the cancel-to-stop gap. The disabled policy rejects any start that was
		// concurrently preparing, and this stop waits for the dispatcher tail.
		await attempt(() =>
			this.stopDelivery({
				accountId: identity.accountId,
				clearPending: true,
			}),
		);
		try {
			await this.discardActivityRuns(identity.accountId);
		} catch (error) {
			cleanupFailure ??= error;
			await attempt(() => this.quiesceActivityRuns(identity.accountId));
		}
		await attempt(() =>
			this.repository.clearPendingProactiveFeedbackData(identity.accountId),
		);
		await attempt(() =>
			this.clearReflectionHandoffs(identity.accountId, {
				requireCompletion: true,
			}),
		);
		if (cleanupFailure !== null) throw cleanupFailure;
		await this.repository.completeProactiveFeedbackPendingReset(
			identity.accountId,
		);
		this.resetSatisfiedAccounts.add(identity.accountId);
	}

	private async finishPendingClear(
		identity: AuthSessionIdentity,
	): Promise<ClearProactiveFeedbackResult> {
		this.revokeOwner();
		let cleanupFailure: unknown = null;
		let result: ClearProactiveFeedbackResult | null = null;
		const attempt = async (
			operation: () => Promise<unknown>,
		): Promise<void> => {
			try {
				await operation();
			} catch (error) {
				cleanupFailure ??= error;
			}
		};

		await attempt(() => this.clearPetPresentation());
		await attempt(() => this.cutoverCloudOwner(null));
		try {
			this.abortActivityRequests();
		} catch (error) {
			cleanupFailure ??= error;
		}
		// The durable clear marker rejects pending starts while stop drains every
		// already-scheduled dispatcher turn. Cancelling the coordinator afterward
		// therefore covers the complete, stable set of activity consumers.
		await attempt(() =>
			this.stopDelivery({
				accountId: identity.accountId,
				clearPending: true,
			}),
		);
		try {
			await this.discardActivityRuns(identity.accountId);
		} catch (error) {
			cleanupFailure ??= error;
			await attempt(() => this.quiesceActivityRuns(identity.accountId));
		}
		await attempt(() =>
			this.clearReflectionHandoffs(identity.accountId, {
				requireCompletion: true,
			}),
		);
		await attempt(async () => {
			result = await this.repository.clearProactiveFeedbackData(
				identity.accountId,
			);
		});
		if (cleanupFailure !== null) throw cleanupFailure;
		if (result === null) {
			throw new Error("Proactive feedback data cleanup did not complete.");
		}
		await this.repository.completeProactiveFeedbackClear(identity.accountId);
		return result;
	}

	private async prepareEnable(identity: AuthSessionIdentity): Promise<void> {
		this.assertSession(identity);
		// A durable disabled policy is the cleanup journal. Repair its complete
		// destructive barrier before committing enabled=true: the earlier disable
		// may have crashed before rotating the repository work epoch or clearing a
		// pending copy. Re-running the barrier is idempotent and prevents old async
		// writes from spanning the disabled interval and reviving after re-enable.
		await this.disableAccount(identity);
		this.assertSession(identity);
		this.markPreparedAfterStrongBarrier(identity);
	}

	private async activateOwner(identity: AuthSessionIdentity): Promise<void> {
		this.assertSession(identity);
		this.assertActivationCandidate(identity);
		if (!sameIdentity(this.preparedSessionIdentity, identity)) {
			throw new Error(
				"Proactive feedback session was not prepared for owner activation.",
			);
		}
		// The local owner is the publication point used by collection and pet
		// presentation. Keep it revoked until the durable cloud cutover succeeds.
		this.revokeOwner();
		await this.cutoverCloudOwner(identity.accountId);
		try {
			this.assertSession(identity);
		} catch (error) {
			await this.cutoverCloudOwner(null).catch(() => undefined);
			throw error;
		}
		this.desiredOwnerAccountId = identity.accountId;
		this.presentationOwner = structuredClone(identity);
		this.presentationNotBeforeMs = this.now() + 1;
		this.resetSatisfiedAccounts.delete(identity.accountId);
	}

	private async activateOwnerAndStartDelivery(
		identity: AuthSessionIdentity,
		publishOwner = true,
	): Promise<void> {
		try {
			if (publishOwner) await this.activateOwner(identity);
			else {
				this.assertSession(identity);
				this.assertActivationCandidate(identity);
				if (!sameIdentity(this.preparedSessionIdentity, identity)) {
					throw new Error(
						"Proactive feedback session was not prepared for delivery startup.",
					);
				}
			}
			this.assertSession(identity);
			await this.startDelivery();
			this.assertSession(identity);
		} catch (activationError) {
			if (sameIdentity(this.preparedSessionIdentity, identity)) {
				this.preparedSessionIdentity = null;
			}
			this.revokeOwner();
			const cleanupFailures: unknown[] = [];
			const attempt = async (
				operation: () => unknown | Promise<unknown>,
			): Promise<void> => {
				try {
					await operation();
				} catch (error) {
					cleanupFailures.push(error);
				}
			};
			await attempt(() => this.clearPetPresentation());
			await attempt(() => this.cutoverCloudOwner(null));
			await attempt(() => this.abortActivityRequests());
			await attempt(() =>
				this.stopDelivery({
					accountId: identity.accountId,
					clearPending: false,
				}),
			);
			await attempt(() => this.quiesceActivityRuns(identity.accountId));
			if (cleanupFailures.length > 0) {
				throw new AggregateError(
					[activationError, ...cleanupFailures],
					"Proactive feedback activation and its fail-closed cleanup did not complete.",
				);
			}
			throw activationError;
		}
	}

	private async failClosedAfterAuthFailure(
		identity: AuthSessionIdentity,
		cause: unknown,
		requireCurrentSession: boolean,
	): Promise<void> {
		if (sameIdentity(this.preparedSessionIdentity, identity)) {
			this.preparedSessionIdentity = null;
		}
		this.report(cause);
		try {
			await this.serial(async () => {
				// A delayed startup retry must never revoke a newer account/session. The
				// pre-activation adapter runs inside RemoteAuth's transition lock, before
				// the incoming identity is visible, so it intentionally has no such guard.
				if (requireCurrentSession && !this.isCurrentSession(identity)) return;
				this.revokeOwner();
				if (requireCurrentSession) {
					await this.clearPetActivationBarrier();
				}
				const attempt = async (
					operation: () => Promise<unknown>,
				): Promise<void> => {
					try {
						await operation();
					} catch (error) {
						this.report(error);
					}
				};
				await this.clearCloudOwnerActivationBarrier();
				try {
					this.abortActivityRequests();
				} catch (error) {
					this.report(error);
				}
				// Preserve every durable pending copy. A later session-ready retry or
				// process restart resumes the same semantic work after the fault clears.
				await attempt(() =>
					this.stopDelivery({
						accountId: identity.accountId,
						clearPending: false,
					}),
				);
				await attempt(() => this.quiesceActivityRuns(identity.accountId));
			});
		} catch (fallbackError) {
			if (fallbackError instanceof ProactiveFeedbackPetBarrierError) {
				this.revokeOwner();
				this.report(fallbackError.originalError);
				throw fallbackError;
			}
			if (fallbackError instanceof ProactiveFeedbackOwnerBarrierError) {
				this.revokeOwner();
				this.report(fallbackError.originalError);
				throw fallbackError;
			}
			// This adapter is an optional-auth boundary. Even a broken diagnostic or
			// session predicate must not escape into RemoteAuth and revoke its tokens.
			this.revokeOwner();
			this.report(fallbackError);
		}
	}

	private async clearPetActivationBarrier(): Promise<void> {
		try {
			await this.clearPetPresentation();
		} catch (error) {
			throw new ProactiveFeedbackPetBarrierError(error);
		}
	}

	private async clearCloudOwnerActivationBarrier(): Promise<void> {
		try {
			await this.cutoverCloudOwner(null);
		} catch (error) {
			throw new ProactiveFeedbackOwnerBarrierError(error);
		}
	}

	private revokeOwner(): void {
		this.desiredOwnerAccountId = null;
		this.presentationOwner = null;
		this.presentationNotBeforeMs = Number.POSITIVE_INFINITY;
	}

	private markPreparedAfterStrongBarrier(identity: AuthSessionIdentity): void {
		this.activationCandidateIdentity = structuredClone(identity);
		this.preparedSessionIdentity = structuredClone(identity);
	}

	private cleanupAccount(accountId: string): Promise<unknown> {
		const protectedRunIds = this.protectedActivityRunIds(accountId);
		return this.repository.cleanupProactiveFeedback(
			accountId,
			this.now(),
			protectedRunIds,
		);
	}

	private assertSession(identity: AuthSessionIdentity): void {
		if (!this.isCurrentSession(identity)) {
			throw new Error(
				"Proactive feedback session changed during the operation.",
			);
		}
	}

	private assertActivationCandidate(identity: AuthSessionIdentity): void {
		if (
			this.activationCandidateIdentity !== null &&
			!sameIdentity(this.activationCandidateIdentity, identity)
		) {
			throw new Error(
				"Proactive feedback session was superseded during activation.",
			);
		}
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closed) {
			return Promise.reject(
				new Error("Proactive feedback runtime is shutting down."),
			);
		}
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private report(error: unknown): void {
		try {
			this.onError(error);
		} catch {
			// Cleanup diagnostics cannot stop the next daily attempt.
		}
	}
}

function sameIdentity(
	left: AuthSessionIdentity | null,
	right: AuthSessionIdentity,
): boolean {
	return (
		left !== null &&
		left.accountId === right.accountId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation
	);
}
