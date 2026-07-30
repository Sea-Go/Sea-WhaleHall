import type {
	MonitoringConfiguration,
	MonitoringPermissionId,
	MonitoringSnapshot,
} from "./domain";
import {
	monitoringFailureMessage,
	type MonitoringService,
} from "./monitoring-service";

export type MonitoringOperation =
	| "configure"
	| "enable"
	| "pause"
	| "resume"
	| "refreshPermissions"
	| "openPermissionSettings";

export type MonitoringState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; snapshot: MonitoringSnapshot }
	| {
			status: "updating";
			operation: MonitoringOperation;
			snapshot: MonitoringSnapshot;
	  }
	| {
			status: "error";
			message: string;
			snapshot: MonitoringSnapshot | null;
			retryable: true;
	  };

type Listener = () => void;

export class MonitoringController {
	private state: MonitoringState = { status: "idle" };
	private readonly listeners = new Set<Listener>();
	private pending: Promise<MonitoringSnapshot | null> | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly service: MonitoringService,
		private readonly pollIntervalMs = 10_000,
	) {}

	readonly getSnapshot = (): MonitoringState => this.state;
	readonly getServerSnapshot = (): MonitoringState => this.state;

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

	load(options: { background?: boolean } = {}): Promise<MonitoringSnapshot | null> {
		if (this.pending) return this.pending;
		const previous = snapshotFromState(this.state);
		if (!options.background || previous === null) {
			this.setState({ status: "loading" });
		}
		return this.run(async () => this.service.status(), previous);
	}

	pause(): Promise<MonitoringSnapshot | null> {
		return this.perform("pause", () => this.service.pause());
	}

	configure(
		configuration: MonitoringConfiguration,
	): Promise<MonitoringSnapshot | null> {
		return this.perform(
			"configure",
			() => this.service.configure(configuration),
		);
	}

	enable(): Promise<MonitoringSnapshot | null> {
		const snapshot = snapshotFromState(this.state);
		if (snapshot === null) return this.load();
		return this.perform("enable", () =>
			this.service.configure({
				enabled: true,
				captureContent: snapshot.captureContent,
				excludedAppIds: snapshot.excludedAppIds,
			}),
		);
	}

	resume(): Promise<MonitoringSnapshot | null> {
		return this.perform("resume", () => this.service.resume());
	}

	refreshPermissions(): Promise<MonitoringSnapshot | null> {
		return this.perform(
			"refreshPermissions",
			() => this.service.refreshPermissions(),
		);
	}

	openPermissionSettings(
		permission: MonitoringPermissionId,
	): Promise<MonitoringSnapshot | null> {
		return this.perform("openPermissionSettings", async () => {
			const snapshot = snapshotFromState(this.state);
			if (snapshot === null) {
				throw new Error("Monitoring status is unavailable.");
			}
			await this.service.openPermissionSettings(permission);
			return snapshot;
		});
	}

	private perform(
		operation: MonitoringOperation,
		action: () => Promise<MonitoringSnapshot>,
	): Promise<MonitoringSnapshot | null> {
		if (this.pending) return this.pending;
		const previous = snapshotFromState(this.state);
		if (previous === null) return this.load();
		this.setState({ status: "updating", operation, snapshot: previous });
		return this.run(action, previous);
	}

	private run(
		action: () => Promise<MonitoringSnapshot>,
		previous: MonitoringSnapshot | null,
	): Promise<MonitoringSnapshot | null> {
		const request = action()
			.then((snapshot) => {
				this.setState({ status: "ready", snapshot });
				return snapshot;
			})
			.catch((reason: unknown) => {
				this.setState({
					status: "error",
					message: monitoringFailureMessage(reason),
					snapshot: previous,
					retryable: true,
				});
				return null;
			})
			.finally(() => {
				if (this.pending === request) this.pending = null;
			});
		this.pending = request;
		return request;
	}

	private setState(state: MonitoringState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

function snapshotFromState(state: MonitoringState): MonitoringSnapshot | null {
	return "snapshot" in state ? state.snapshot : null;
}
