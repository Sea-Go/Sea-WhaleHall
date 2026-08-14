interface ExclusiveWaiter {
	resolve: () => void;
}

class PlanningVaultExclusiveGate {
	private locked = false;
	private readonly waiters: ExclusiveWaiter[] = [];

	async run<T>(operation: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await operation();
		} finally {
			this.release();
		}
	}

	private async acquire(): Promise<void> {
		if (!this.locked) {
			this.locked = true;
			return;
		}
		await new Promise<void>((resolve) => {
			this.waiters.push({ resolve });
		});
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) {
			next.resolve();
			return;
		}
		this.locked = false;
	}
}

const gates = new WeakMap<object, PlanningVaultExclusiveGate>();

/**
 * Serializes planning seals, optimistic snapshot writes, and planning Vault GC
 * for every repository sharing the same native runtime object.
 */
export function withPlanningVaultExclusiveLease<T>(
	owner: object,
	operation: () => Promise<T>,
): Promise<T> {
	let gate = gates.get(owner);
	if (!gate) {
		gate = new PlanningVaultExclusiveGate();
		gates.set(owner, gate);
	}
	return gate.run(operation);
}
