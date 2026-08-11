import { hostname } from "node:os";
import { join } from "node:path";
import type {
	DataCenterAuthSessionProjection,
	DataCenterSyncStatus,
} from "../../shared/datacenter";
import type { LocalMonitoringStatus } from "../../agent/local-protocol";
import type { DataCenterRuntimeConfiguration } from "../client-config";
import {
	loadOrCreateAgentIdentity,
	readStoredIdentity,
	signAgentRequest,
	type AgentSigningRequest,
	type Ed25519AgentIdentity,
} from "./agent-identity";
import {
	DataCenterAuthClient,
	DataCenterAuthError,
} from "./auth-client";
import {
	consentInputsFromMonitoring,
} from "./consent";
import { DataCenterHttpClient, DataCenterHttpError } from "./http";
import {
	buildAgentDeviceInfo,
	isAgentRegistrationConflict,
	registerAgent,
	type AgentDeviceInfo,
} from "./registration";
import {
	createSecureValueStore,
	type SecureValueStore,
} from "./secure-store";
import {
	DATACENTER_SYNC_CONSUMER_ID,
	DataCenterSyncLoop,
	type DataCenterEventSource,
} from "./sync-loop";
import type {
	DataCenterAgentRegistration,
	DataCenterConsentInput,
	DataCenterNativeSession,
} from "./types";
import { projectNativeSession } from "./types";

const SESSION_KEY = "session.v1";
const REGISTRATION_KEY = "agent-registration.v1";
const SESSION_EXPIRY_SKEW_MS = 5_000;

export type DataCenterAgentBridge = DataCenterEventSource & {
	getMonitoringStatus(): Promise<LocalMonitoringStatus>;
};

export type DataCenterServiceOptions = {
	configuration: DataCenterRuntimeConfiguration;
	localDataPath: string;
	agent: DataCenterAgentBridge;
	platform?: NodeJS.Platform;
	now?: () => number;
};

export class DataCenterService {
	private readonly configuration: DataCenterRuntimeConfiguration;
	private readonly store: SecureValueStore;
	private readonly http: DataCenterHttpClient;
	private readonly auth: DataCenterAuthClient;
	private readonly agent: DataCenterAgentBridge;
	private readonly now: () => number;
	private readonly identityPromise: Promise<Ed25519AgentIdentity>;
	private readonly syncLoop: DataCenterSyncLoop;

	constructor(options: DataCenterServiceOptions) {
		this.configuration = options.configuration;
		this.store = createSecureValueStore({
			directory: join(options.localDataPath, "datacenter", "keys"),
			platform: options.platform,
		});
		this.http = new DataCenterHttpClient({
			baseUrl: options.configuration.baseUrl,
		});
		this.auth = new DataCenterAuthClient(this.http);
		this.agent = options.agent;
		this.now = options.now ?? Date.now;
		this.identityPromise = loadOrCreateAgentIdentity(this.store);
		this.syncLoop = new DataCenterSyncLoop({
			intervalMs: options.configuration.syncIntervalMs,
			stateFile: join(
				options.localDataPath,
				"datacenter",
				"sync-state.v1.json",
			),
			now: this.now,
			context: {
				baseUrl: options.configuration.baseUrl,
				http: this.http,
				eventSource: options.agent,
				identity: this.identityPromise,
				readAccessToken: async () =>
					(await this.readSession())?.accessToken ?? null,
				readAgentId: async () =>
					(await this.readRegistration())?.agentId ?? null,
				registerAgent: async () => this.ensureRegistered(),
				now: this.now,
			},
		});
	}

	start(): void {
		this.syncLoop.start();
	}

	stop(): void {
		this.syncLoop.stop();
	}

	get baseUrl(): string {
		return this.configuration.baseUrl;
	}

	async signIn(
		email: string,
		password: string,
	): Promise<DataCenterAuthSessionProjection> {
		const session = await this.auth.signIn(email, password);
		await this.writeSession(session);
		this.syncLoop.trigger();
		return projectNativeSession(session);
	}

	async signOut(): Promise<void> {
		const session = await this.readSession();
		if (session !== null) {
			await this.auth.signOut(session.accessToken);
		}
		this.store.delete(SESSION_KEY);
		this.store.delete(REGISTRATION_KEY);
		await this.syncLoop.setEnabled(false);
	}

	async restoreSession(): Promise<DataCenterAuthSessionProjection | null> {
		const session = await this.readSession();
		if (session === null) return null;
		if (this.now() + SESSION_EXPIRY_SKEW_MS < session.expiresAtMs) {
			return projectNativeSession(session);
		}
		try {
			const refreshed = await this.auth.refresh(session.refreshToken);
			await this.writeSession(refreshed);
			this.syncLoop.trigger();
			return projectNativeSession(refreshed);
		} catch (error) {
			if (isTransientAuthFailure(error)) {
				// A transient network failure must not discard the stored
				// session; the WebView surfaces a retryable error instead.
				throw error;
			}
			this.store.delete(SESSION_KEY);
			this.store.delete(REGISTRATION_KEY);
			return null;
		}
	}

	async getSyncStatus(): Promise<DataCenterSyncStatus> {
		return this.syncLoop.getStatus();
	}

	async setSyncEnabled(enabled: boolean): Promise<DataCenterSyncStatus> {
		await this.syncLoop.setEnabled(enabled);
		if (enabled) {
			const session = await this.readSession();
			if (session !== null) {
				await this.ensureRegistered();
				this.syncLoop.trigger();
			}
		}
		return this.syncLoop.getStatus();
	}

	async refreshConsents(): Promise<DataCenterSyncStatus> {
		const session = await this.readSession();
		const registration = await this.readRegistration();
		if (session !== null && registration !== null) {
			await this.syncConsents(session.accessToken, registration.deviceId);
		}
		return this.syncLoop.getStatus();
	}

	private async readSession(): Promise<DataCenterNativeSession | null> {
		const raw = this.store.get(SESSION_KEY);
		if (raw === null) return null;
		try {
			const parsed = JSON.parse(raw) as Partial<DataCenterNativeSession>;
			if (
				typeof parsed.id === "string" &&
				typeof parsed.accessToken === "string" &&
				parsed.accessToken.length > 0 &&
				typeof parsed.refreshToken === "string" &&
				parsed.refreshToken.length > 0 &&
				typeof parsed.expiresAtMs === "number" &&
				isRecord(parsed.user)
			) {
				return parsed as DataCenterNativeSession;
			}
		} catch {
			// Corrupt session is cleared below.
		}
		this.store.delete(SESSION_KEY);
		return null;
	}

	private writeSession(session: DataCenterNativeSession): void {
		this.store.set(SESSION_KEY, JSON.stringify(session));
	}

	private async readRegistration(): Promise<DataCenterAgentRegistration | null> {
		const raw = this.store.get(REGISTRATION_KEY);
		if (raw === null) return null;
		try {
			const parsed = JSON.parse(raw) as Partial<DataCenterAgentRegistration>;
			if (
				typeof parsed.agentId === "string" &&
				parsed.agentId.length > 0 &&
				typeof parsed.deviceId === "string" &&
				parsed.deviceId.length > 0
			) {
				return parsed as DataCenterAgentRegistration;
			}
		} catch {
			// Corrupt registration is regenerated.
		}
		return null;
	}

	private async ensureRegistered(): Promise<DataCenterAgentRegistration | null> {
		const existing = await this.readRegistration();
		if (existing !== null) return existing;
		const session = await this.readSession();
		if (session === null) return null;
		try {
			const identity = await this.identityPromise;
			const device = await this.buildDeviceInfo(identity);
			const registration = await registerAgent({
				http: this.http,
				accessToken: session.accessToken,
				identity,
				device,
			});
			this.store.set(REGISTRATION_KEY, JSON.stringify(registration));
			await this.syncConsents(session.accessToken, registration.deviceId);
			return registration;
		} catch (error) {
			if (isAgentRegistrationConflict(error)) {
				return null;
			}
			if (error instanceof DataCenterHttpError && error.status === 401) {
				return null;
			}
			return null;
		}
	}

	private async buildDeviceInfo(
		identity: Ed25519AgentIdentity,
	): Promise<AgentDeviceInfo> {
		return buildAgentDeviceInfo({
			platform: process.platform,
			hostname: hostname(),
			installationId: identity.installationId,
		});
	}

	private async syncConsents(
		accessToken: string,
		deviceId: string,
	): Promise<void> {
		let monitoring: LocalMonitoringStatus;
		try {
			monitoring = await this.agent.getMonitoringStatus();
		} catch {
			return;
		}
		const inputs = consentInputsFromMonitoring(monitoring);
		for (const input of inputs) {
			try {
				await this.putConsent(accessToken, deviceId, input);
			} catch {
				// A single failed consent must not abort the rest; the sync
				// loop surfaces the last state through its status.
			}
		}
	}

	private putConsent(
		accessToken: string,
		deviceId: string,
		input: DataCenterConsentInput,
	): Promise<unknown> {
		return this.http.put(
			`/v1/devices/${encodeURIComponent(deviceId)}/consents/${input.sensor}`,
			{
				granted: input.granted,
				data_level: input.dataLevel,
				policy_version: input.policyVersion ?? "v1",
			},
			{ bearer: accessToken },
		);
	}

	/** Signs a canonical Agent request with the local Ed25519 identity. */
	async signAgentRequest(request: AgentSigningRequest): Promise<string> {
		const identity = await this.identityPromise;
		return signAgentRequest(identity, request);
	}

	async debugIdentity(): Promise<{ installationId: string } | null> {
		const identity = readStoredIdentity(this.store);
		return identity === null ? null : { installationId: identity.installationId };
	}
}

export { DataCenterAuthError };

function isTransientAuthFailure(error: unknown): boolean {
	return (
		error instanceof DataCenterAuthError &&
		(error.kind === "offline" ||
			error.kind === "service_unavailable" ||
			error.kind === "unexpected")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
