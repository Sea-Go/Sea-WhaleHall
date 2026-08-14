import type {
	ProactiveFeedbackPolicy,
	ProactiveFeedbackPolicySnapshot,
	ProactiveFeedbackRetention,
} from "../../../../shared/proactive-feedback";
import {
	type ProactiveFeedbackService,
	proactiveFeedbackFailureMessage,
} from "./proactive-feedback-service";

interface PolicyReadyState {
	snapshot: ProactiveFeedbackPolicySnapshot;
}

export type ProactiveFeedbackPolicyState =
	| { status: "idle" }
	| { status: "loading" }
	| ({ status: "ready" } & PolicyReadyState)
	| ({
			status: "saving";
			requested: ProactiveFeedbackPolicy;
	  } & PolicyReadyState)
	| ({ status: "success"; message: string } & PolicyReadyState)
	| { status: "error"; stage: "load"; message: string; retryable: true }
	| ({
			status: "error";
			stage: "save" | "clear";
			message: string;
			retryable: true;
	  } & PolicyReadyState)
	| ({ status: "clearing" } & PolicyReadyState);

type Listener = () => void;

export class ProactiveFeedbackPolicyController {
	private state: ProactiveFeedbackPolicyState = { status: "idle" };
	private readonly listeners = new Set<Listener>();
	private operation: Promise<unknown> | null = null;
	private operationVersion = 0;

	constructor(private readonly service: ProactiveFeedbackService) {}

	readonly getSnapshot = (): ProactiveFeedbackPolicyState => this.state;
	readonly getServerSnapshot = (): ProactiveFeedbackPolicyState => this.state;
	readonly subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	load(): Promise<ProactiveFeedbackPolicySnapshot | null> {
		if (this.operation)
			return this.operation as Promise<ProactiveFeedbackPolicySnapshot | null>;
		const version = ++this.operationVersion;
		this.setState({ status: "loading" });
		const request = this.performLoad(version);
		this.track(request);
		return request;
	}

	setEnabled(
		enabled: boolean,
	): Promise<ProactiveFeedbackPolicySnapshot | null> {
		const snapshot = snapshotFromState(this.state);
		if (!snapshot || this.operation) return Promise.resolve(null);
		return this.save({ ...snapshot.policy, enabled }, snapshot);
	}

	setRetention(
		retention: ProactiveFeedbackRetention,
	): Promise<ProactiveFeedbackPolicySnapshot | null> {
		const snapshot = snapshotFromState(this.state);
		if (!snapshot || this.operation) return Promise.resolve(null);
		return this.save({ ...snapshot.policy, retention }, snapshot);
	}

	clear(): Promise<boolean> {
		const snapshot = snapshotFromState(this.state);
		if (!snapshot || this.operation) return Promise.resolve(false);
		const version = ++this.operationVersion;
		this.setState({ status: "clearing", snapshot: cloneSnapshot(snapshot) });
		const request = this.performClear(snapshot, version);
		this.track(request);
		return request;
	}

	private async performLoad(
		version: number,
	): Promise<ProactiveFeedbackPolicySnapshot | null> {
		try {
			const snapshot = cloneSnapshot(await this.service.loadPolicy());
			if (version !== this.operationVersion) return null;
			this.setState({ status: "ready", snapshot });
			return cloneSnapshot(snapshot);
		} catch (reason) {
			if (version !== this.operationVersion) return null;
			this.setState({
				status: "error",
				stage: "load",
				message: proactiveFeedbackFailureMessage(reason, "load-policy"),
				retryable: true,
			});
			return null;
		}
	}

	private save(
		policy: ProactiveFeedbackPolicy,
		previous: ProactiveFeedbackPolicySnapshot,
	): Promise<ProactiveFeedbackPolicySnapshot | null> {
		if (samePolicy(policy, previous.policy))
			return Promise.resolve(cloneSnapshot(previous));
		const version = ++this.operationVersion;
		this.setState({
			status: "saving",
			requested: { ...policy },
			snapshot: cloneSnapshot(previous),
		});
		const request = this.performSave(policy, previous, version);
		this.track(request);
		return request;
	}

	private async performSave(
		policy: ProactiveFeedbackPolicy,
		previous: ProactiveFeedbackPolicySnapshot,
		version: number,
	): Promise<ProactiveFeedbackPolicySnapshot | null> {
		try {
			const snapshot = cloneSnapshot(
				await this.service.setPolicy(policy, previous.revision),
			);
			if (version !== this.operationVersion) return null;
			this.setState({
				status: "success",
				message: "主动反馈设置已保存。",
				snapshot,
			});
			return cloneSnapshot(snapshot);
		} catch (reason) {
			if (version !== this.operationVersion) return null;
			this.setState({
				status: "error",
				stage: "save",
				message: proactiveFeedbackFailureMessage(reason, "save-policy"),
				retryable: true,
				snapshot: cloneSnapshot(previous),
			});
			return null;
		}
	}

	private async performClear(
		snapshot: ProactiveFeedbackPolicySnapshot,
		version: number,
	): Promise<boolean> {
		try {
			await this.service.clear();
			if (version !== this.operationVersion) return false;
			this.setState({
				status: "success",
				message: "本机主动反馈数据已清除。",
				snapshot: cloneSnapshot(snapshot),
			});
			return true;
		} catch (reason) {
			if (version !== this.operationVersion) return false;
			this.setState({
				status: "error",
				stage: "clear",
				message: proactiveFeedbackFailureMessage(reason, "clear"),
				retryable: true,
				snapshot: cloneSnapshot(snapshot),
			});
			return false;
		}
	}

	private track<T>(request: Promise<T>): void {
		this.operation = request;
		void request.finally(() => {
			if (this.operation === request) this.operation = null;
		});
	}

	private setState(state: ProactiveFeedbackPolicyState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

function snapshotFromState(
	state: ProactiveFeedbackPolicyState,
): ProactiveFeedbackPolicySnapshot | null {
	return "snapshot" in state ? state.snapshot : null;
}

function cloneSnapshot(
	snapshot: ProactiveFeedbackPolicySnapshot,
): ProactiveFeedbackPolicySnapshot {
	return { ...snapshot, policy: { ...snapshot.policy } };
}

function samePolicy(
	left: ProactiveFeedbackPolicy,
	right: ProactiveFeedbackPolicy,
): boolean {
	return left.enabled === right.enabled && left.retention === right.retention;
}
