import { LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL } from "./credential-helper-client";
import type { DataCenterProductionOriginCutoverPreparation } from "./encrypted-agent-repository";

export const DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_ID =
	"datacenter-production-origin-v1";

export interface DataCenterProductionOriginCutoverRepository {
	prepareDataCenterProductionOriginCutover(
		cutoverId: string,
	): DataCenterProductionOriginCutoverPreparation;
	completeDataCenterProductionOriginCutover(cutoverId: string): void;
}

export interface DataCenterProductionOriginCredentialStore {
	delete(name: string): Promise<void>;
}

export type DataCenterProductionOriginCutoverResult =
	| "completed"
	| "already-complete";

/**
 * Runs before authentication or any DataCenter network owner exists.
 *
 * SQLite preparation clears every origin-bound transport row in the same
 * transaction that records the incomplete migration. The OS credential delete
 * is then allowed to cross that local transaction boundary. Completion is
 * recorded last, so a crash or failure can only cause an idempotent retry.
 */
export async function runDataCenterProductionOriginCutover(options: {
	repository: DataCenterProductionOriginCutoverRepository;
	credentials: DataCenterProductionOriginCredentialStore;
	cutoverId?: string;
}): Promise<DataCenterProductionOriginCutoverResult> {
	const cutoverId =
		options.cutoverId ?? DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_ID;
	const preparation =
		options.repository.prepareDataCenterProductionOriginCutover(cutoverId);
	if (preparation === "already-complete") return "already-complete";

	await options.credentials.delete(LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL);
	options.repository.completeDataCenterProductionOriginCutover(cutoverId);
	return "completed";
}
