import {
	AGENT_READ_PERMISSION_IDS,
	type AgentReadPermissionsSnapshot,
} from "../../../../shared/agent-permissions";
import {
	AgentPermissionsServiceError,
	type AgentPermissionsFailureKind,
	type AgentPermissionsService,
} from "../../features/settings/agent-permissions-service";

export interface MockAgentPermissionsServiceOptions {
	latencyMs?: number;
	enabled?: boolean;
	now?: () => number;
	loadFailure?: AgentPermissionsFailureKind | null;
	saveFailureCount?: number;
}

/** Browser-QA/test adapter. Production grants are persisted only by Bun. */
export class MockAgentPermissionsService implements AgentPermissionsService {
	private readonly latencyMs: number;
	private readonly now: () => number;
	private readonly loadFailure: AgentPermissionsFailureKind | null;
	private saveFailureCount: number;
	private snapshot: AgentReadPermissionsSnapshot;

	constructor(options: MockAgentPermissionsServiceOptions = {}) {
		this.latencyMs = options.latencyMs ?? 120;
		this.now = options.now ?? Date.now;
		this.loadFailure = options.loadFailure ?? null;
		this.saveFailureCount = Math.max(0, options.saveFailureCount ?? 0);
		this.snapshot = {
			grants: options.enabled ? [...AGENT_READ_PERMISSION_IDS] : [],
			revision: 0,
			updatedAtMs: null,
		};
	}

	async load(): Promise<AgentReadPermissionsSnapshot> {
		await this.wait();
		if (this.loadFailure) {
			throw new AgentPermissionsServiceError(this.loadFailure);
		}
		return cloneSnapshot(this.snapshot);
	}

	async setEnabled(
		enabled: boolean,
		expectedRevision: number,
	): Promise<AgentReadPermissionsSnapshot> {
		await this.wait();
		if (this.saveFailureCount > 0) {
			this.saveFailureCount -= 1;
			throw new AgentPermissionsServiceError("save-failed");
		}
		if (expectedRevision !== this.snapshot.revision) {
			throw new AgentPermissionsServiceError(
				"version-conflict",
				undefined,
				this.snapshot.revision,
			);
		}
		this.snapshot = {
			grants: enabled ? [...AGENT_READ_PERMISSION_IDS] : [],
			revision: this.snapshot.revision + 1,
			updatedAtMs: this.now(),
		};
		return cloneSnapshot(this.snapshot);
	}

	private async wait(): Promise<void> {
		if (this.latencyMs <= 0) return;
		await new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs));
	}
}

function cloneSnapshot(
	snapshot: AgentReadPermissionsSnapshot,
): AgentReadPermissionsSnapshot {
	return {
		grants: [...snapshot.grants],
		revision: snapshot.revision,
		updatedAtMs: snapshot.updatedAtMs,
	};
}
