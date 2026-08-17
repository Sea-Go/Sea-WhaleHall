import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AUTH_REFRESH_TOKEN_CREDENTIAL,
	LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL,
} from "../src/bun/credential-helper-client";
import { DATA_CENTER_CONSUMER_ID } from "../src/bun/data-center-contract";
import {
	DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_CREDENTIAL_ERROR_CODE,
	DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_ID,
	DataCenterProductionOriginCutoverCredentialError,
	type DataCenterProductionOriginCutoverRepository,
	runDataCenterProductionOriginCutover,
} from "../src/bun/data-center-origin-cutover";
import { RemoteAuthSessionManager } from "../src/bun/remote-auth-session";

describe("DataCenter production-origin cutover", () => {
	test("orders durable preparation, legacy-token deletion, and completion", async () => {
		const order: string[] = [];
		const repository = new MemoryCutoverRepository(order);
		const credentials = new MemoryCredentials(order);
		credentials.values.set(
			LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL,
			"staging-refresh-token",
		);
		credentials.values.set(
			AUTH_REFRESH_TOKEN_CREDENTIAL,
			"production-refresh-token",
		);

		await expect(
			runDataCenterProductionOriginCutover({ repository, credentials }),
		).resolves.toBe("completed");
		expect(order).toEqual([
			`prepare:${DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_ID}`,
			`delete:${LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL}`,
			`complete:${DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_ID}`,
		]);
		expect(repository.transportRows).toBe(0);
		expect(
			credentials.values.has(LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL),
		).toBeFalse();
		expect(credentials.values.get(AUTH_REFRESH_TOKEN_CREDENTIAL)).toBe(
			"production-refresh-token",
		);

		order.length = 0;
		await expect(
			runDataCenterProductionOriginCutover({ repository, credentials }),
		).resolves.toBe("already-complete");
		expect(order).toEqual([
			`prepare:${DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_ID}`,
		]);
	});

	test("repeats prepared cleanup after token deletion fails", async () => {
		const order: string[] = [];
		const repository = new MemoryCutoverRepository(order);
		const credentials = new MemoryCredentials(order);
		credentials.failDelete = true;
		credentials.values.set(
			LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL,
			"staging-refresh-token",
		);

		const failure = runDataCenterProductionOriginCutover({
			repository,
			credentials,
		});
		await expect(failure).rejects.toBeInstanceOf(
			DataCenterProductionOriginCutoverCredentialError,
		);
		await expect(failure).rejects.toMatchObject({
			code: DATA_CENTER_PRODUCTION_ORIGIN_CUTOVER_CREDENTIAL_ERROR_CODE,
			message: expect.stringContaining(
				"No DataCenter network service was started",
			),
		});
		await expect(failure).rejects.not.toThrow(
			"injected credential deletion failure",
		);
		expect(repository.state).toBe("prepared");
		expect(repository.completeCalls).toBe(0);
		expect(repository.transportRows).toBe(0);

		// A retired concurrent writer may repopulate both persistence domains while
		// the new application is down. Recovery must clear them again.
		repository.transportRows = 5;
		credentials.values.set(
			LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL,
			"staging-refresh-token-rewritten",
		);
		credentials.failDelete = false;
		await expect(
			runDataCenterProductionOriginCutover({ repository, credentials }),
		).resolves.toBe("completed");
		expect(repository.prepareCalls).toBe(2);
		expect(repository.transportRows).toBe(0);
		expect(
			credentials.values.has(LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL),
		).toBeFalse();
	});

	test("retries safely when completion fails after the legacy token is gone", async () => {
		const order: string[] = [];
		const repository = new MemoryCutoverRepository(order);
		repository.failComplete = true;
		const credentials = new MemoryCredentials(order);

		await expect(
			runDataCenterProductionOriginCutover({ repository, credentials }),
		).rejects.toThrow("injected cutover completion failure");
		expect(repository.state).toBe("prepared");
		expect(credentials.deleteCalls).toBe(1);

		repository.failComplete = false;
		await expect(
			runDataCenterProductionOriginCutover({ repository, credentials }),
		).resolves.toBe("completed");
		expect(repository.prepareCalls).toBe(2);
		expect(credentials.deleteCalls).toBe(2);
	});

	test("never reads a legacy token rewritten after cutover completion", async () => {
		const order: string[] = [];
		const repository = new MemoryCutoverRepository(order);
		const credentials = new MemoryCredentials(order);
		await runDataCenterProductionOriginCutover({ repository, credentials });

		// This models a downgraded or concurrently running staging build. It only
		// knows the retired credential name, while the production client owns a new
		// slot that the old binary cannot overwrite.
		credentials.values.set(
			LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL,
			"staging-refresh-token-rewritten",
		);
		credentials.values.set(
			AUTH_REFRESH_TOKEN_CREDENTIAL,
			"production-refresh-token",
		);
		let refreshBody: unknown = null;
		const auth = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://data.sea-ridethewindbreakthewaves.xyz",
			fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				refreshBody = init?.body ? JSON.parse(String(init.body)) : null;
				return Response.json(productionSessionPayload());
			}) as unknown as typeof fetch,
		});

		await expect(auth.restoreSession()).resolves.toMatchObject({
			id: "production-session",
		});
		expect(refreshBody).toEqual({
			refreshToken: "production-refresh-token",
		});
		expect(JSON.stringify(refreshBody)).not.toContain("staging-refresh-token");
	});

	test("startup awaits cutover before constructing authentication or sync", () => {
		const source = readFileSync(
			join(import.meta.dir, "..", "src", "bun", "index.ts"),
			"utf8",
		);
		const cutover = source.indexOf(
			"await runDataCenterProductionOriginCutover",
		);
		const auth = source.indexOf("new RemoteAuthSessionManager");
		const sync = source.indexOf("new DataCenterSyncService");
		expect(cutover).toBeGreaterThan(-1);
		expect(auth).toBeGreaterThan(cutover);
		expect(sync).toBeGreaterThan(auth);
		expect(DATA_CENTER_CONSUMER_ID).toBe("whalehall.datacenter.production.v1");
	});
});

class MemoryCutoverRepository
	implements DataCenterProductionOriginCutoverRepository
{
	state: "prepared" | "complete" | null = null;
	transportRows = 5;
	prepareCalls = 0;
	completeCalls = 0;
	failComplete = false;

	constructor(private readonly order: string[]) {}

	prepareDataCenterProductionOriginCutover(
		cutoverId: string,
	): "prepared" | "already-complete" {
		this.prepareCalls += 1;
		this.order.push(`prepare:${cutoverId}`);
		if (this.state === "complete") return "already-complete";
		this.state = "prepared";
		this.transportRows = 0;
		return "prepared";
	}

	completeDataCenterProductionOriginCutover(cutoverId: string): void {
		this.completeCalls += 1;
		this.order.push(`complete:${cutoverId}`);
		if (this.failComplete) {
			throw new Error("injected cutover completion failure");
		}
		if (this.state !== "prepared") {
			throw new Error("cutover was not prepared");
		}
		this.state = "complete";
	}
}

class MemoryCredentials {
	readonly values = new Map<string, string>();
	deleteCalls = 0;
	failDelete = false;

	constructor(private readonly order: string[]) {}

	async read(name: string): Promise<string | null> {
		return this.values.get(name) ?? null;
	}

	async write(name: string, value: string): Promise<void> {
		this.values.set(name, value);
	}

	async delete(name: string): Promise<void> {
		this.deleteCalls += 1;
		this.order.push(`delete:${name}`);
		if (this.failDelete) {
			throw new Error("injected credential deletion failure");
		}
		this.values.delete(name);
	}
}

function productionSessionPayload() {
	return {
		id: "production-session",
		accessToken: "production-access-token-0123456789",
		refreshToken: "production-refresh-token-rotated-0123456789",
		expiresAtMs: Date.now() + 15 * 60_000,
		user: {
			id: "production-account",
			displayName: "Production User",
			email: "production@example.test",
			initials: "PU",
		},
	};
}
