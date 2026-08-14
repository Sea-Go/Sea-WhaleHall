import type { AppUpdateSnapshot } from "../../../../shared/app-update";
import type { AppUpdateService } from "./app-update-service";
import {
	type AppUpdateControllerState,
	type AppUpdateOperation,
	appUpdateFailureMessage,
} from "./domain";

type Listener = () => void;

/**
 * Owns renderer-side single-flight actions only. Scheduling, mandatory update
 * policy, signature verification, task draining, replacement and restart remain
 * authoritative in the Bun update service, including while this window is closed.
 */
export class AppUpdateController {
	private state: AppUpdateControllerState = { status: "idle" };
	private readonly listeners = new Set<Listener>();
	private pending: Promise<AppUpdateSnapshot | null> | null = null;
	private unsubscribeService: (() => void) | null = null;
	private started = false;

	constructor(private readonly service: AppUpdateService) {}

	readonly getSnapshot = (): AppUpdateControllerState => this.state;
	readonly getServerSnapshot = (): AppUpdateControllerState => this.state;
	readonly subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	start(): void {
		if (this.started) return;
		this.started = true;
		this.unsubscribeService = this.service.subscribe((snapshot) => {
			this.acceptSnapshot(snapshot);
		});
		void this.load();
	}

	stop(): void {
		this.started = false;
		this.unsubscribeService?.();
		this.unsubscribeService = null;
	}

	load(): Promise<AppUpdateSnapshot | null> {
		if (this.pending) return this.pending;
		if (!("snapshot" in this.state)) this.setState({ status: "loading" });
		return this.perform("load", () => this.service.getStatus());
	}

	check(): Promise<AppUpdateSnapshot | null> {
		return this.perform("check", () => this.service.check());
	}

	download(): Promise<AppUpdateSnapshot | null> {
		return this.perform("download", () => this.service.download());
	}

	installAndRestart(): Promise<AppUpdateSnapshot | null> {
		return this.perform("install", () => this.service.installAndRestart());
	}

	retry(): Promise<AppUpdateSnapshot | null> {
		if (this.state.status !== "error") return this.load();
		switch (this.state.operation) {
			case "load":
				return this.load();
			case "check":
				return this.check();
			case "download":
				return this.download();
			case "install":
				return this.installAndRestart();
		}
	}

	private perform(
		operation: AppUpdateOperation,
		action: () => Promise<AppUpdateSnapshot>,
	): Promise<AppUpdateSnapshot | null> {
		if (this.pending) return this.pending;
		const previous = "snapshot" in this.state ? this.state.snapshot : null;
		if (previous !== null) {
			this.setState({
				status: "ready",
				snapshot: previous,
				operation: operation === "load" ? null : operation,
			});
		}
		const request = action()
			.then((snapshot) => {
				this.acceptSnapshot(snapshot);
				return snapshot;
			})
			.catch((reason: unknown) => {
				this.setState({
					status: "error",
					snapshot: previous,
					operation,
					message: appUpdateFailureMessage(reason, operation),
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

	private acceptSnapshot(snapshot: AppUpdateSnapshot): void {
		this.setState({ status: "ready", snapshot, operation: null });
	}

	private setState(state: AppUpdateControllerState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}
