import {
	clonePreferencesSnapshot,
	clonePreferenceValues,
	createDefaultPreferences,
	isPreferenceValues,
	preferencesSnapshotFromUnknown,
	type PreferenceValues,
	type PreferencesSnapshot,
} from "../../features/settings/domain";
import {
	PreferencesServiceError,
	type PreferencesFailureKind,
	type PreferencesService,
} from "../../features/settings/preferences-service";

const STORAGE_KEY = "whalehall.preferences.v1";
const DEFAULT_LATENCY_MS = 180;

export interface PreferencesStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface MockPreferencesServiceOptions {
	latencyMs?: number;
	now?: () => number;
	storage?: PreferencesStorage | null;
	loadFailure?: PreferencesFailureKind | null;
	saveFailureCount?: number;
	saveFailureKind?: PreferencesFailureKind;
}

export class MockPreferencesService implements PreferencesService {
	private readonly latencyMs: number;
	private readonly now: () => number;
	private readonly storage: PreferencesStorage | null;
	private readonly loadFailure: PreferencesFailureKind | null;
	private saveFailureCount: number;
	private readonly saveFailureKind: PreferencesFailureKind;
	private memorySnapshot: PreferencesSnapshot | null = null;

	constructor(options: MockPreferencesServiceOptions = {}) {
		this.latencyMs = options.latencyMs ?? DEFAULT_LATENCY_MS;
		this.now = options.now ?? Date.now;
		this.storage =
			options.storage === undefined ? getLocalStorage() : options.storage;
		this.loadFailure = options.loadFailure ?? null;
		this.saveFailureCount = Math.max(0, options.saveFailureCount ?? 0);
		this.saveFailureKind = options.saveFailureKind ?? "save-failed";
	}

	async load(): Promise<PreferencesSnapshot> {
		await this.wait();
		if (this.loadFailure) {
			throw new PreferencesServiceError(this.loadFailure);
		}
		return clonePreferencesSnapshot(this.readSnapshot());
	}

	async save(
		values: PreferenceValues,
		expectedVersion: number,
	): Promise<PreferencesSnapshot> {
		await this.wait();
		if (!isPreferenceValues(values)) {
			throw new PreferencesServiceError("save-failed");
		}
		if (this.saveFailureCount > 0) {
			this.saveFailureCount -= 1;
			throw new PreferencesServiceError(this.saveFailureKind);
		}

		const current = this.readSnapshot();
		if (current.version !== expectedVersion) {
			throw new PreferencesServiceError("version-conflict");
		}
		const snapshot: PreferencesSnapshot = {
			values: clonePreferenceValues(values),
			version: current.version + 1,
			savedAtMs: this.now(),
		};
		this.writeSnapshot(snapshot);
		return clonePreferencesSnapshot(snapshot);
	}

	private readSnapshot(): PreferencesSnapshot {
		if (this.memorySnapshot) {
			return clonePreferencesSnapshot(this.memorySnapshot);
		}
		if (this.storage) {
			try {
				const serialized = this.storage.getItem(STORAGE_KEY);
				if (serialized) {
					const parsed: unknown = JSON.parse(serialized);
					const snapshot = preferencesSnapshotFromUnknown(parsed);
					if (snapshot) {
						this.memorySnapshot = clonePreferencesSnapshot(snapshot);
						return clonePreferencesSnapshot(snapshot);
					}
					this.storage.removeItem(STORAGE_KEY);
				}
			} catch {
				try {
					this.storage.removeItem(STORAGE_KEY);
				} catch {
					// The in-memory fallback remains deterministic.
				}
			}
		}
		const snapshot: PreferencesSnapshot = {
			values: createDefaultPreferences(),
			version: 0,
			savedAtMs: null,
		};
		this.memorySnapshot = clonePreferencesSnapshot(snapshot);
		return snapshot;
	}

	private writeSnapshot(snapshot: PreferencesSnapshot): void {
		if (this.storage) {
			try {
				this.storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
			} catch {
				throw new PreferencesServiceError("save-failed");
			}
		}
		this.memorySnapshot = clonePreferencesSnapshot(snapshot);
	}

	private async wait(): Promise<void> {
		if (this.latencyMs <= 0) return;
		await new Promise<void>((resolve) => {
			setTimeout(resolve, this.latencyMs);
		});
	}
}

function getLocalStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}
