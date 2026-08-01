import {
	isAgentReadPermissionsSnapshot,
	type AgentReadPermissionsFailureKind,
	type AgentReadPermissionsSnapshot,
	type SetAgentReadPermissionsRequest,
} from "../../../../shared/agent-permissions";
import {
	AgentPermissionsServiceError,
	type AgentPermissionsFailureKind,
	type AgentPermissionsService,
} from "../../features/settings/agent-permissions-service";

export interface AgentPermissionsRpcClient {
	getAgentReadPermissions(): Promise<unknown>;
	setAgentReadPermissions(
		request: SetAgentReadPermissionsRequest,
	): Promise<unknown>;
}

/** Production adapter. The Renderer never sends or derives an account id. */
export class ElectrobunAgentPermissionsService
	implements AgentPermissionsService
{
	constructor(private readonly injectedClient?: AgentPermissionsRpcClient) {}

	async load(): Promise<AgentReadPermissionsSnapshot> {
		const result = this.injectedClient
			? await this.injectedClient.getAgentReadPermissions()
			: await invokeClientApi("getAgentReadPermissions");
		return unwrap(result);
	}

	async setEnabled(
		enabled: boolean,
		expectedRevision: number,
	): Promise<AgentReadPermissionsSnapshot> {
		const request: SetAgentReadPermissionsRequest = {
			enabled,
			expectedRevision,
		};
		const result = this.injectedClient
			? await this.injectedClient.setAgentReadPermissions(request)
			: await invokeClientApi("setAgentReadPermissions", request);
		return unwrap(result);
	}
}

function unwrap(value: unknown): AgentReadPermissionsSnapshot {
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw invalidResponse();
	}
	if (value.kind === "success") {
		if (!isAgentReadPermissionsSnapshot(value.data)) throw invalidResponse();
		return {
			grants: [...value.data.grants],
			revision: value.data.revision,
			updatedAtMs: value.data.updatedAtMs,
		};
	}
	if (value.kind !== "error" || !isFailureKind(value.failure)) {
		throw invalidResponse();
	}
	const currentRevision =
		typeof value.currentRevision === "number" &&
		Number.isSafeInteger(value.currentRevision) &&
		value.currentRevision >= 0
			? value.currentRevision
			: undefined;
	throw new AgentPermissionsServiceError(
		mapFailure(value.failure),
		undefined,
		currentRevision,
	);
}

async function invokeClientApi(
	methodName: "getAgentReadPermissions" | "setAgentReadPermissions",
	request?: SetAgentReadPermissionsRequest,
): Promise<unknown> {
	if (!hasElectrobunRuntime()) {
		throw new AgentPermissionsServiceError("unavailable");
	}
	const imported: unknown = await import("../../rpc");
	if (!isRecord(imported) || !isRecord(imported.clientApi)) {
		throw new AgentPermissionsServiceError("unavailable");
	}
	const method = imported.clientApi[methodName];
	if (typeof method !== "function") {
		throw new AgentPermissionsServiceError("unavailable");
	}
	const invocation: unknown = Reflect.apply(
		method,
		imported.clientApi,
		request ? [request] : [],
	);
	return Promise.resolve(invocation);
}

function mapFailure(
	failure: AgentReadPermissionsFailureKind,
): AgentPermissionsFailureKind {
	switch (failure) {
		case "offline":
			return "offline";
		case "service-unavailable":
			return "unavailable";
		case "version-conflict":
			return "version-conflict";
		case "unexpected":
			return "save-failed";
	}
}

function isFailureKind(value: unknown): value is AgentReadPermissionsFailureKind {
	return (
		value === "offline" ||
		value === "service-unavailable" ||
		value === "version-conflict" ||
		value === "unexpected"
	);
}

function invalidResponse(): AgentPermissionsServiceError {
	return new AgentPermissionsServiceError("invalid-response");
}

function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
