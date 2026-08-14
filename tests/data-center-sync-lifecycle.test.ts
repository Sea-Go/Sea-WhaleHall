import { describe, expect, test } from "bun:test";
import type { AuthSessionIdentity } from "../src/bun/auth-session";
import {
	type CloudSyncConfiguration,
	WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
} from "../src/bun/client-config";
import {
	type DataCenterBearerAuthorization,
	type DataCenterEventJournal,
	type DataCenterSyncRepository,
	DataCenterSyncService,
} from "../src/bun/data-center-sync";

const enabledMetadata: CloudSyncConfiguration = {
	enabled: true,
	contentEncryptionEnabled: false,
	consents: {
		activity: "metadata",
		browser: "metadata",
		presence: "metadata",
	},
};

describe("DataCenterSyncService lifecycle", () => {
	test("stop reaches a fixed point before a later session may restart", async () => {
		const auth = new UnauthenticatedSession();
		const service = createService(auth);

		try {
			service.start();
			await waitForCondition(() => auth.captureCalls === 1);

			const stopping = service.stop();
			service.start();
			expect(await service.syncOnce()).toBeFalse();
			await stopping;
			expect(auth.captureCalls).toBe(1);

			service.start();
			await waitForCondition(() => auth.captureCalls === 2);
		} finally {
			await service.stop();
		}
	});

	test("shutdown rejects deferred sign-in and restore tails before owner close", async () => {
		const auth = new UnauthenticatedSession();
		const service = createService(auth);
		let releaseSignIn!: () => void;
		let releaseRestore!: () => void;
		const signInGate = new Promise<void>((resolve) => {
			releaseSignIn = resolve;
		});
		const restoreGate = new Promise<void>((resolve) => {
			releaseRestore = resolve;
		});
		const deferredSignInTail = signInGate.then(() => service.start());
		const deferredRestoreTail = restoreGate.then(() => service.start());

		service.start();
		await waitForCondition(() => auth.captureCalls === 1);
		service.beginShutdown();
		await service.stop();

		let ownerClosed = false;
		const closeOwner = (async () => {
			await Promise.all([deferredSignInTail, deferredRestoreTail]);
			await service.stop();
			ownerClosed = true;
		})();

		releaseSignIn();
		await deferredSignInTail;
		expect(ownerClosed).toBeFalse();
		expect(auth.captureCalls).toBe(1);
		expect(await service.syncOnce()).toBeFalse();

		releaseRestore();
		await closeOwner;
		expect(ownerClosed).toBeTrue();
		expect(auth.captureCalls).toBe(1);
	});
});

class UnauthenticatedSession implements DataCenterBearerAuthorization {
	captureCalls = 0;

	captureCurrentSession(): AuthSessionIdentity | null {
		this.captureCalls += 1;
		return null;
	}

	isCurrentSession(_identity: AuthSessionIdentity): boolean {
		return false;
	}

	async bearerFetch(): Promise<Response> {
		throw new Error("The unauthenticated lifecycle fixture must not fetch.");
	}
}

function createService(
	auth: DataCenterBearerAuthorization,
): DataCenterSyncService {
	return new DataCenterSyncService({
		baseUrl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
		configuration: enabledMetadata,
		repository: unreachableDependency<DataCenterSyncRepository>("repository"),
		events: unreachableDependency<DataCenterEventJournal>("event journal"),
		auth,
		retryDelayMs: 0,
		syncIntervalMs: 60_000,
		loopRestartDelayMs: 0,
	});
}

function unreachableDependency<T extends object>(label: string): T {
	return new Proxy({} as T, {
		get() {
			throw new Error(
				`The unauthenticated lifecycle fixture accessed ${label}.`,
			);
		},
	});
}

async function waitForCondition(
	predicate: () => boolean,
	timeoutMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for the test condition.");
		}
		await Bun.sleep(1);
	}
}
