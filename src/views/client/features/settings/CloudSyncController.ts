import type { DataCenterSyncStatus } from "../../../../shared/contracts";
import type { CloudSyncService } from "./cloud-sync-service";

export type CloudSyncOperation = "set-enabled" | "refresh-consents";

export type CloudSyncState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; snapshot: DataCenterSyncStatus }
	| {
			status: "updating";
			operation: CloudSyncOperation;
			snapshot: DataCenterSyncStatus;
	  }
	| {
			status: "error";
			message: string;
			snapshot: DataCenterSyncStatus | null;
	  };

type Listener = () => void;

export class CloudSyncController {
	private state: CloudSyncState = { status: "idle" };
	private readonly listeners = new Set<Listener>();
	private pending: Promise<DataCenterSyncStatus | null> | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly service: CloudSyncService,
		private readonly pollIntervalMs = 15_000,
	) {}

	readonly getSnapshot = (): CloudSyncState => this.state;
	readonly getServerSnapshot = (): CloudSyncState => this.state;

	readonly subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	start(): void {
		if (this.pollTimer !== null) return;
		void this.load();
		this.pollTimer = setInterval(() => {
			if (this.pending === null) void this.load({ background: true });
		}, this.pollIntervalMs);
	}

	stop(): void {
		if (this.pollTimer === null) return;
		clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	load(options: { background?: boolean } = {}): Promise<DataCenterSyncStatus | null> {
		if (this.pending) return this.pending;
		const previous = snapshotFromState(this.state);
		if (!options.background || previous === null) {
			this.setState({ status: "loading" });
		}
		this.pending = this.run(() => this.service.status(), previous);
		return this.pending;
	}

	setEnabled(enabled: boolean): Promise<DataCenterSyncStatus | null> {
		return this.perform("set-enabled", () => this.service.setEnabled(enabled));
	}

	refreshConsents(): Promise<DataCenterSyncStatus | null> {
		return this.perform("refresh-consents", () => this.service.refreshConsents());
	}

	private perform(
		operation: CloudSyncOperation,
		request: () => Promise<DataCenterSyncStatus>,
	): Promise<DataCenterSyncStatus | null> {
		if (this.pending) return this.pending;
		const previous = snapshotFromState(this.state);
		if (previous === null) {
			this.setState({ status: "loading" });
		} else {
			this.setState({ status: "updating", operation, snapshot: previous });
		}
		this.pending = this.run(request, previous);
		return this.pending;
	}

	private async run(
		request: () => Promise<DataCenterSyncStatus>,
		previous: DataCenterSyncStatus | null,
	): Promise<DataCenterSyncStatus | null> {
		try {
			const snapshot = await request();
			this.setState({ status: "ready", snapshot });
			return snapshot;
		} catch (reason) {
			this.setState({
				status: "error",
				message: cloudSyncFailureMessage(reason),
				snapshot: previous,
			});
			return null;
		} finally {
			this.pending = null;
		}
	}

	private setState(state: CloudSyncState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

export function cloudSyncFailureMessage(reason: unknown): string {
	if (
		typeof reason === "object" &&
		reason !== null &&
		"message" in reason &&
		typeof reason.message === "string" &&
		reason.message.trim()
	) {
		return "暂时无法读取云同步状态，请稍后重试。";
	}
	return "暂时无法读取云同步状态。";
}

function snapshotFromState(state: CloudSyncState): DataCenterSyncStatus | null {
	if ("snapshot" in state) return state.snapshot;
	return null;
}
