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

export const DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_CREDENTIAL_ERROR_CODE =
	"LEGACY_CREDENTIAL_DELETE_FAILED";

/**
 * Fatal startup error raised when the retired origin credential cannot be
 * removed. Authentication and DataCenter network owners must not start while
 * an old origin credential may still be present.
 */
export class DataCenterProductionOriginCutoverCredentialError extends Error {
	readonly code = DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_CREDENTIAL_ERROR_CODE;

	constructor() {
		super(
			"WhaleHall could not establish the production authentication boundary because the retired credential could not be removed. No DataCenter network service was started; restart after secure credential storage is available.",
		);
		this.name = "DataCenterProductionOriginCutoverCredentialError";
	}
}

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

	try {
		await options.credentials.delete(LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL);
	} catch {
		// Fail closed without retaining or exposing the credential-store error.
		// The durable journal remains prepared, so a later launch repeats both
		// local cleanup and deletion before any network owner can be constructed.
		throw new DataCenterProductionOriginCutoverCredentialError();
	}
	options.repository.completeDataCenterProductionOriginCutover(cutoverId);
	return "completed";
}
