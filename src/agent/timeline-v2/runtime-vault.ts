import type {
	LocalVaultDeleteBatch,
	LocalVaultDeleteBatchResult,
	LocalVaultOpenBatch,
	LocalVaultOpenBatchResult,
	LocalVaultSealBatch,
	LocalVaultSealBatchResult,
} from "../local-protocol";
import { canonicalJson } from "../reflection/hash";
import type {
	TimelineVault,
	TimelineVaultDeleteRequest,
	TimelineVaultOpenRequest,
	TimelineVaultSealRequest,
} from "./vault";
import { TimelineVaultUnavailableError } from "./vault";

export interface RuntimeVaultTransport {
	sealVaultBatch(
		batch: LocalVaultSealBatch,
	): Promise<LocalVaultSealBatchResult>;
	openVaultBatch(
		batch: LocalVaultOpenBatch,
	): Promise<LocalVaultOpenBatchResult>;
	deleteVaultBatch(
		batch: LocalVaultDeleteBatch,
	): Promise<LocalVaultDeleteBatchResult>;
}

type SealedTimelineEnvelope = {
	aad: Record<string, string | number | null>;
	payload: unknown;
};

/**
 * Adapts TimelineVault to Rust's generic vault.sealBatch/openBatch contract.
 * Purpose becomes the vault namespace; AAD is stored inside the authenticated
 * content envelope and checked again on open.
 */
export class RuntimeTimelineVault implements TimelineVault {
	constructor(private readonly runtime: RuntimeVaultTransport) {}

	async seal(request: TimelineVaultSealRequest): Promise<string> {
		let payload: unknown;
		try {
			payload = JSON.parse(request.plaintext);
		} catch {
			throw new TimelineVaultUnavailableError(
				"Timeline vault accepts JSON plaintext only.",
			);
		}
		const result = await this.runtime.sealVaultBatch({
			namespace: request.purpose,
			records: [
				{
					recordId: request.recordId,
					schemaVersion: request.schemaVersion,
					content: {
						aad: request.aad,
						payload,
					} satisfies SealedTimelineEnvelope,
					expiresAtMs: request.expiresAtMs,
				},
			],
		});
		const record = result.records[0];
		if (!record || record.recordId !== request.recordId) {
			throw new TimelineVaultUnavailableError(
				"Rust vault seal result did not match its record.",
			);
		}
		return record.contentRef;
	}

	async open(request: TimelineVaultOpenRequest): Promise<string> {
		const result = await this.runtime.openVaultBatch({
			namespace: request.purpose,
			contentRefs: [request.sealedPayload],
		});
		const record = result.records[0];
		if (
			!record ||
			record.recordId !== request.recordId ||
			record.schemaVersion !== request.schemaVersion ||
			record.contentRef !== request.sealedPayload ||
			!isRecord(record.content) ||
			!isRecord(record.content.aad) ||
			canonicalJson(record.content.aad) !==
				canonicalJson(request.aad) ||
			!("payload" in record.content)
		) {
			throw new TimelineVaultUnavailableError(
				"Rust vault open result failed Timeline v2 AAD validation.",
			);
		}
		return JSON.stringify(record.content.payload);
	}

	async deleteRecords(request: TimelineVaultDeleteRequest): Promise<void> {
		if (request.recordIds.length === 0) return;
		const result = await this.runtime.deleteVaultBatch({
			namespace: request.purpose,
			recordIds: request.recordIds,
		});
		if (
			result.records.length !== request.recordIds.length ||
			!result.records.every(
				(record, index) => record.recordId === request.recordIds[index],
			)
		) {
			throw new TimelineVaultUnavailableError(
				"Rust vault delete result did not match its request.",
			);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
