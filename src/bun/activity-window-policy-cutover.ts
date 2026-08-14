export interface ActivityWindowPolicyCutoverStore {
	getLegacyPolicyCutoverStatus(accountId: string): {
		state: "pending" | "complete";
	};
	clearLegacyPolicyCutoverWorkerData(accountId: string): unknown;
	markLegacyPolicyCutoverComplete(accountId: string): boolean;
}

export interface ActivityWindowPolicyCutoverSource {
	clearWindowsForAccount(accountId: string): Promise<unknown>;
}

export interface ActivityWindowPolicyCutoverArchive {
	beginProactiveFeedbackPendingReset(accountId: string): Promise<void>;
	isProactiveFeedbackPendingReset(accountId: string): Promise<boolean>;
	clearPendingProactiveFeedbackData(accountId: string): Promise<unknown>;
	completeProactiveFeedbackPendingReset(accountId: string): Promise<void>;
}

/**
 * One-way, crash-safe boundary between the legacy Worker ledger and the
 * account-owned encrypted proactive-feedback archive. A pending marker blocks
 * every Worker dispatch until both legacy copies have been removed.
 */
export async function completeLegacyActivityPolicyCutover(
	store: ActivityWindowPolicyCutoverStore,
	source: ActivityWindowPolicyCutoverSource,
	archive: ActivityWindowPolicyCutoverArchive,
	accountId: string,
): Promise<void> {
	const legacyPending =
		store.getLegacyPolicyCutoverStatus(accountId).state === "pending";
	const resetPending = await archive.isProactiveFeedbackPendingReset(accountId);
	if (!legacyPending && !resetPending) return;
	if (!resetPending) {
		await archive.beginProactiveFeedbackPendingReset(accountId);
	}
	if (legacyPending) store.clearLegacyPolicyCutoverWorkerData(accountId);
	await archive.clearPendingProactiveFeedbackData(accountId);
	await source.clearWindowsForAccount(accountId);
	if (legacyPending && !store.markLegacyPolicyCutoverComplete(accountId)) {
		throw new Error("Legacy activity policy cutover marker was not committed.");
	}
	await archive.completeProactiveFeedbackPendingReset(accountId);
}
