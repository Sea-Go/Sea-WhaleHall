import { createHash } from "node:crypto";
import { DataCenterHttpError, DataCenterHttpClient } from "./http";
import type {
	DataCenterAgentIdentity,
	DataCenterAgentRegistration,
} from "./types";

export type AgentDeviceInfo = {
	deviceName: string;
	deviceType: string;
	osType: string;
	agentVersion: string;
	fingerprint: string;
};

export const WHALEHALL_AGENT_VERSION = "0.1.0";

export function buildAgentDeviceInfo(options: {
	platform: NodeJS.Platform;
	hostname: string;
	installationId: string;
}): AgentDeviceInfo {
	const osType = describeOs(options.platform);
	const deviceType = "desktop";
	return {
		deviceName: options.hostname || "whalehall",
		deviceType,
		osType,
		agentVersion: WHALEHALL_AGENT_VERSION,
		fingerprint: sha256Hex(`${options.installationId}:${options.hostname}`),
	};
}

export async function registerAgent(options: {
	http: DataCenterHttpClient;
	accessToken: string;
	identity: DataCenterAgentIdentity;
	device: AgentDeviceInfo;
}): Promise<DataCenterAgentRegistration> {
	const response = await options.http.post<{
		agent_id?: unknown;
		device_id?: unknown;
		config_version?: unknown;
	}>("/v1/agent/register", {
		device_name: options.device.deviceName,
		device_type: options.device.deviceType,
		os_type: options.device.osType,
		fingerprint: options.device.fingerprint,
		agent_version: options.device.agentVersion,
		installation_id: options.identity.installationId,
		public_key: options.identity.publicKeyB64,
	}, {
		bearer: options.accessToken,
	});
	if (
		typeof response.agent_id !== "string" ||
		response.agent_id.length === 0 ||
		typeof response.device_id !== "string" ||
		response.device_id.length === 0 ||
		typeof response.config_version !== "number"
	) {
		throw new Error("DataCenter agent registration returned an invalid body.");
	}
	return {
		agentId: response.agent_id,
		deviceId: response.device_id,
		configVersion: response.config_version,
	};
}

export function isAgentRegistrationConflict(error: unknown): boolean {
	return (
		error instanceof DataCenterHttpError &&
		error.kind === "http" &&
		error.status === 409
	);
}

function describeOs(platform: NodeJS.Platform): string {
	switch (platform) {
		case "darwin":
			return "macos";
		case "win32":
			return "windows";
		case "linux":
			return "linux";
		default:
			return platform;
	}
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
