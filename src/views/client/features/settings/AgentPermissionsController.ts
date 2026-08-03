import {
	hasAllAgentReadPermissions,
	hasAnyAgentReadPermission,
	type AgentReadPermissionsSnapshot,
} from "../../../../shared/agent-permissions";
import {
	agentPermissionsFailureMessage,
	type AgentPermissionsService,
} from "./agent-permissions-service";

interface AgentPermissionsSnapshotState {
	snapshot: AgentReadPermissionsSnapshot;
}

export type AgentPermissionsState =
	| { status: "idle" }
	| { status: "loading" }
	| ({ status: "ready" } & AgentPermissionsSnapshotState)
	| ({ status: "saving"; requestedEnabled: boolean } &
			AgentPermissionsSnapshotState)
	| ({ status: "success"; message: string } &
			AgentPermissionsSnapshotState)
	| {
			status: "error";
			stage: "load";
			message: string;
			retryable: true;
	  }
	| ({
			status: "error";
			stage: "save";
			requestedEnabled: boolean;
			message: string;
			retryable: true;
	  } & AgentPermissionsSnapshotState);

type StateListener = () => void;

export class AgentPermissionsController {
	private state: AgentPermissionsState = { status: "idle" };
	private readonly listeners = new Set<StateListener>();
	private loadPromise: Promise<AgentReadPermissionsSnapshot | null> | null = null;
	private savePromise: Promise<AgentReadPermissionsSnapshot | null> | null = null;
	private operationVersion = 0;

	constructor(private readonly service: AgentPermissionsService) {}

	readonly getSnapshot = (): AgentPermissionsState => this.state;
	readonly getServerSnapshot = (): AgentPermissionsState => this.state;

	readonly subscribe = (listener: StateListener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	load(): Promise<AgentReadPermissionsSnapshot | null> {
		if (this.loadPromise) return this.loadPromise;
		const operationVersion = ++this.operationVersion;
		this.setState({ status: "loading" });
		const request = this.performLoad(operationVersion);
		this.loadPromise = request;
		void request.finally(() => {
			if (this.loadPromise === request) this.loadPromise = null;
		});
		return request;
	}

	setEnabled(enabled: boolean): Promise<AgentReadPermissionsSnapshot | null> {
		if (this.savePromise) return this.savePromise;
		if (!("snapshot" in this.state)) return Promise.resolve(null);

		const snapshot = cloneSnapshot(this.state.snapshot);
		const alreadyEnabled = hasAllAgentReadPermissions(snapshot);
		const alreadyRevoked = !hasAnyAgentReadPermission(snapshot);
		if ((enabled && alreadyEnabled) || (!enabled && alreadyRevoked)) {
			return Promise.resolve(snapshot);
		}

		const operationVersion = ++this.operationVersion;
		this.setState({
			status: "saving",
			requestedEnabled: enabled,
			snapshot,
		});
		const request = this.performSave(
			enabled,
			snapshot,
			operationVersion,
		);
		this.savePromise = request;
		void request.finally(() => {
			if (this.savePromise === request) this.savePromise = null;
		});
		return request;
	}

	retry(): Promise<AgentReadPermissionsSnapshot | null> {
		if (this.state.status !== "error") return Promise.resolve(null);
		return this.state.stage === "load"
			? this.load()
			: this.setEnabled(this.state.requestedEnabled);
	}

	private async performLoad(
		operationVersion: number,
	): Promise<AgentReadPermissionsSnapshot | null> {
		try {
			const snapshot = cloneSnapshot(await this.service.load());
			if (operationVersion !== this.operationVersion) return null;
			this.setState({ status: "ready", snapshot });
			return cloneSnapshot(snapshot);
		} catch (reason) {
			if (operationVersion !== this.operationVersion) return null;
			this.setState({
				status: "error",
				stage: "load",
				message: agentPermissionsFailureMessage(reason, "load"),
				retryable: true,
			});
			return null;
		}
	}

	private async performSave(
		enabled: boolean,
		previous: AgentReadPermissionsSnapshot,
		operationVersion: number,
	): Promise<AgentReadPermissionsSnapshot | null> {
		try {
			const snapshot = cloneSnapshot(
				await this.service.setEnabled(enabled, previous.revision),
			);
			if (operationVersion !== this.operationVersion) return null;
			this.setState({
				status: "success",
				message: enabled
					? "已启用本地 Agent 读取授权。"
					: "已撤销本地 Agent 读取授权。",
				snapshot,
			});
			return cloneSnapshot(snapshot);
		} catch (reason) {
			if (operationVersion !== this.operationVersion) return null;
			this.setState({
				status: "error",
				stage: "save",
				requestedEnabled: enabled,
				message: agentPermissionsFailureMessage(reason, "save"),
				retryable: true,
				snapshot: cloneSnapshot(previous),
			});
			return null;
		}
	}

	private setState(state: AgentPermissionsState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
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
