import {
	clonePreferencesSnapshot,
	clonePreferenceValues,
	createDefaultPreferences,
	preferenceValuesEqual,
	type PreferenceValues,
	type PreferencesSnapshot,
} from "./domain";
import {
	preferencesFailureMessage,
	type PreferencesService,
} from "./preferences-service";

export type PreferencesOperation = "save" | "restore-defaults";

interface PreferencesReadyState {
	snapshot: PreferencesSnapshot;
	draft: PreferenceValues;
	dirty: boolean;
}

export type PreferencesState =
	| { status: "idle" }
	| { status: "loading" }
	| ({ status: "ready" } & PreferencesReadyState)
	| ({ status: "saving"; operation: PreferencesOperation } &
			PreferencesReadyState)
	| ({ status: "success"; message: string } & PreferencesReadyState)
	| {
			status: "error";
			stage: "load";
			message: string;
			retryable: true;
	  }
	| ({
			status: "error";
			stage: PreferencesOperation;
			message: string;
			retryable: true;
	  } & PreferencesReadyState);

type PreferencesStateListener = () => void;

export class PreferencesController {
	private state: PreferencesState = { status: "idle" };
	private readonly listeners = new Set<PreferencesStateListener>();
	private loadPromise: Promise<PreferencesSnapshot | null> | null = null;
	private savePromise: Promise<PreferencesSnapshot | null> | null = null;
	private operationVersion = 0;

	constructor(private readonly service: PreferencesService) {}

	readonly getSnapshot = (): PreferencesState => this.state;
	readonly getServerSnapshot = (): PreferencesState => this.state;

	readonly subscribe = (listener: PreferencesStateListener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	load(): Promise<PreferencesSnapshot | null> {
		if (this.loadPromise) return this.loadPromise;
		const version = ++this.operationVersion;
		this.setState({ status: "loading" });
		const request = this.performLoad(version);
		this.loadPromise = request;
		void request.finally(() => {
			if (this.loadPromise === request) this.loadPromise = null;
		});
		return request;
	}

	update<K extends keyof PreferenceValues>(
		section: K,
		value: PreferenceValues[K],
	): void {
		if (!hasPreferences(this.state) || this.state.status === "saving") return;
		const draft = clonePreferenceValues(this.state.draft);
		draft[section] = value;
		this.setState({
			status: "ready",
			snapshot: clonePreferencesSnapshot(this.state.snapshot),
			draft,
			dirty: !preferenceValuesEqual(this.state.snapshot.values, draft),
		});
	}

	save(): Promise<PreferencesSnapshot | null> {
		if (this.savePromise) return this.savePromise;
		if (!hasPreferences(this.state) || !this.state.dirty) {
			return Promise.resolve(
				hasPreferences(this.state)
					? clonePreferencesSnapshot(this.state.snapshot)
					: null,
			);
		}
		return this.persist("save", this.state.draft);
	}

	restoreDefaults(): Promise<PreferencesSnapshot | null> {
		if (this.savePromise) return this.savePromise;
		if (!hasPreferences(this.state)) return Promise.resolve(null);
		return this.persist("restore-defaults", createDefaultPreferences());
	}

	private async performLoad(
		operationVersion: number,
	): Promise<PreferencesSnapshot | null> {
		try {
			const snapshot = clonePreferencesSnapshot(await this.service.load());
			if (operationVersion !== this.operationVersion) return null;
			this.setState({
				status: "ready",
				snapshot,
				draft: clonePreferenceValues(snapshot.values),
				dirty: false,
			});
			return clonePreferencesSnapshot(snapshot);
		} catch (reason) {
			if (operationVersion !== this.operationVersion) return null;
			this.setState({
				status: "error",
				stage: "load",
				message: preferencesFailureMessage(reason, "load"),
				retryable: true,
			});
			return null;
		}
	}

	private persist(
		operation: PreferencesOperation,
		values: PreferenceValues,
	): Promise<PreferencesSnapshot | null> {
		if (!hasPreferences(this.state)) return Promise.resolve(null);
		const previous = clonePreferencesSnapshot(this.state.snapshot);
		const draft = clonePreferenceValues(values);
		const operationVersion = ++this.operationVersion;
		this.setState({
			status: "saving",
			operation,
			snapshot: previous,
			draft,
			dirty: !preferenceValuesEqual(previous.values, draft),
		});
		const request = this.performSave(
			operation,
			draft,
			previous,
			operationVersion,
		);
		this.savePromise = request;
		void request.finally(() => {
			if (this.savePromise === request) this.savePromise = null;
		});
		return request;
	}

	private async performSave(
		operation: PreferencesOperation,
		values: PreferenceValues,
		previous: PreferencesSnapshot,
		operationVersion: number,
	): Promise<PreferencesSnapshot | null> {
		try {
			const snapshot = clonePreferencesSnapshot(
				await this.service.save(values, previous.version),
			);
			if (operationVersion !== this.operationVersion) return null;
			this.setState({
				status: "success",
				message:
					operation === "restore-defaults"
						? "已恢复默认设置。"
						: "设置已保存到本机。",
				snapshot,
				draft: clonePreferenceValues(snapshot.values),
				dirty: false,
			});
			return clonePreferencesSnapshot(snapshot);
		} catch (reason) {
			if (operationVersion !== this.operationVersion) return null;
			this.setState({
				status: "error",
				stage: operation,
				message: preferencesFailureMessage(reason, operation),
				retryable: true,
				snapshot: previous,
				draft: clonePreferenceValues(previous.values),
				dirty: false,
			});
			return null;
		}
	}

	private setState(state: PreferencesState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

function hasPreferences(
	state: PreferencesState,
): state is Extract<
	PreferencesState,
	{ snapshot: PreferencesSnapshot }
> {
	return "snapshot" in state;
}
