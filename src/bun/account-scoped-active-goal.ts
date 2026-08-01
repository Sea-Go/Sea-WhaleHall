import {
	cloneActiveGoalContext,
	type ActiveGoalContextV1,
} from "../shared/goal-context";
import type { LocalTestSessionIdentity } from "./local-test-auth-session";

export type ActiveGoalWrite = {
	goalId: string;
	planId: string | null;
	text: string;
	activatedAtMs: number;
} | null;

export interface AccountScopedActiveGoalStoreOptions {
	currentSession: () => LocalTestSessionIdentity | null;
	writeRuntimeGoal: (goal: ActiveGoalWrite) => Promise<ActiveGoalContextV1 | null>;
}

export class ActiveGoalSessionChangedError extends Error {
	constructor() {
		super("测试会话已在目标同步期间发生变化，旧目标未被激活。");
		this.name = "ActiveGoalSessionChangedError";
	}
}

interface ScopedGoal {
	identity: LocalTestSessionIdentity;
	goal: ActiveGoalContextV1;
}

/**
 * Keeps the reflection runtime's process-global goal scoped to one exact local
 * session. Runtime writes are serialized, and a logout invalidates the
 * in-memory projection before any asynchronous cleanup begins.
 */
export class AccountScopedActiveGoalStore {
	private scoped: ScopedGoal | null = null;
	private transitionTail = Promise.resolve();

	constructor(private readonly options: AccountScopedActiveGoalStoreOptions) {}

	getForAccount(accountId: string): ActiveGoalContextV1 | null {
		const current = this.options.currentSession();
		if (
			!current ||
			current.accountId !== accountId ||
			!this.scoped ||
			!sameIdentity(current, this.scoped.identity)
		) {
			return null;
		}
		return cloneActiveGoalContext(this.scoped.goal);
	}

	invalidateSynchronously(): void {
		this.scoped = null;
	}

	async setForCurrentSession(goal: ActiveGoalWrite): Promise<ActiveGoalContextV1 | null> {
		const expected = this.options.currentSession();
		if (!expected) throw new ActiveGoalSessionChangedError();

		return this.withTransitionLock(async () => {
			this.requireCurrent(expected);
			const normalized = await this.options.writeRuntimeGoal(goal);
			if (!this.isCurrent(expected)) {
				this.scoped = null;
				await this.options.writeRuntimeGoal(null);
				throw new ActiveGoalSessionChangedError();
			}
			this.scoped = normalized
				? {
						identity: { ...expected },
						goal: cloneActiveGoalContext(normalized)!,
					}
				: null;
			return cloneActiveGoalContext(normalized);
		});
	}

	async clearForAccountTransition(): Promise<void> {
		this.scoped = null;
		await this.withTransitionLock(async () => {
			this.scoped = null;
			await this.options.writeRuntimeGoal(null);
		});
	}

	private isCurrent(expected: LocalTestSessionIdentity): boolean {
		const current = this.options.currentSession();
		return current !== null && sameIdentity(current, expected);
	}

	private requireCurrent(expected: LocalTestSessionIdentity): void {
		if (!this.isCurrent(expected)) throw new ActiveGoalSessionChangedError();
	}

	private async withTransitionLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.transitionTail;
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => current);
		this.transitionTail = queued;
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.transitionTail === queued) this.transitionTail = Promise.resolve();
		}
	}
}

function sameIdentity(
	left: LocalTestSessionIdentity,
	right: LocalTestSessionIdentity,
): boolean {
	return (
		left.accountId === right.accountId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation
	);
}
