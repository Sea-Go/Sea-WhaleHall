import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalendarRepository } from "../src/bun/calendar-repository";
import {
	CredentialHelperError,
	type CredentialKeyReference,
	type CredentialKeyStore,
} from "../src/bun/credential-helper-client";
import { EncryptedAgentRepository } from "../src/bun/encrypted-agent-repository";
import { LocalAgentHostServices } from "../src/bun/mastra-host-services";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("LocalAgentHostServices workflow storage", () => {
	test("persists, atomically merges, lists and deletes encrypted Mastra snapshots", async () => {
		const repository = createRepository();
		await repository.ensureAccount("account-a");
		let now = 2_000;
		const host = new LocalAgentHostServices({
			runBound: (_ownerRunId, operation) => operation("account-a"),
			repository,
			calendar: new CalendarRepository(repository, { timeZone: () => "Asia/Shanghai" }),
			toolPolicy: {
				async assertReadAllowed(_accountId, toolName) {
					return toolName as "calendar.list_events";
				},
			},
			memory: {
				async load() {
					return { messages: [], version: 0 };
				},
				async append() {
					return { version: 1 };
				},
			},
			tools: {
				async propose() { return {}; },
				async call() { return {}; },
				async cancel() { return {}; },
			},
			now: () => now++,
		});
		const handle = (method: string, params: Record<string, unknown>) =>
			host.handle(method, { ...params, ownerRunId: "sidecar-run-1" });
		const workflowName = "task-planning";
		const runId = "workflow-run-1";
		await handle("workflow/snapshot.persist", {
			workflowName,
			runId,
			resourceId: "account-a",
			createdAtMs: 1_000,
			updatedAtMs: 1_100,
			snapshot: {
				runId,
				status: "running",
				value: {},
				context: {
					parallel: {
						status: "suspended",
						output: [
							{ status: "success", output: "keep" },
							{ status: "suspended", suspendPayload: { question: "x" } },
						],
					},
				},
				serializedStepGraph: [],
				activePaths: [],
				activeStepsPath: {},
				suspendedPaths: {},
				resumeLabels: {},
				waitingPaths: {},
				timestamp: 1_100,
			},
		});

		const [firstContext, secondContext] = await Promise.all([
			handle("workflow/snapshot.update-results", {
				workflowName,
				runId,
				stepId: "step-a",
				result: { status: "success", output: { value: "a" } },
				requestContext: { requestA: true },
			}),
			handle("workflow/snapshot.update-results", {
				workflowName,
				runId,
				stepId: "step-b",
				result: { status: "success", output: { value: "b" } },
				requestContext: { requestB: true },
			}),
		]);
		expect(firstContext).toEqual(expect.objectContaining({
			"step-a": expect.any(Object),
		}));
		expect(secondContext).toEqual(expect.objectContaining({
			"step-a": expect.any(Object),
			"step-b": expect.any(Object),
		}));

		await handle("workflow/snapshot.update-results", {
			workflowName,
			runId,
			stepId: "parallel",
			result: {
				status: "running",
				output: [
					{ __mastra_pending__: true },
					{ __mastra_pending__: true },
				],
			},
			requestContext: {},
		});
		const state = await handle("workflow/snapshot.update-state", {
			workflowName,
			runId,
			opts: {
				status: "suspended",
				suspendedPaths: { clarification: [0] },
			},
		});
		expect(state).toEqual(expect.objectContaining({ status: "suspended" }));

		const loaded = await handle("workflow/snapshot.load", { workflowName, runId });
		expect(loaded).toEqual(expect.objectContaining({
			status: "suspended",
			requestContext: { requestA: true, requestB: true },
			context: {
				parallel: expect.objectContaining({
					output: [
						{ status: "success", output: "keep" },
						null,
					],
				}),
				"step-a": expect.any(Object),
				"step-b": expect.any(Object),
			},
		}));
		const listed = await handle("workflow/snapshot.list", {
			workflowName,
			resourceId: "account-a",
			status: "suspended",
			page: 0,
			perPage: 10,
		});
		expect(listed).toEqual(expect.objectContaining({
			total: 1,
			runs: [expect.objectContaining({ workflowName, runId, resourceId: "account-a" })],
		}));
		await expect(
			handle("workflow/snapshot.get", { runId }),
		).resolves.toEqual(expect.objectContaining({ workflowName, runId }));
		await expect(
			handle("workflow/snapshot.list", { resourceId: "account-b" }),
		).rejects.toThrow("does not match");
		await expect(
			handle("workflow/snapshot.delete", { workflowName, runId }),
		).resolves.toEqual({ deleted: true });
		await expect(
			handle("workflow/snapshot.load", { workflowName, runId }),
		).resolves.toBeNull();
		repository.close();
	});
});

class MemoryKeyStore implements CredentialKeyStore {
	private readonly keys = new Map<string, Uint8Array>();

	async getKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const value = this.keys.get(keyId(reference));
		if (!value) throw new CredentialHelperError("NOT_FOUND");
		return value.slice();
	}

	async createKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		if (this.keys.has(keyId(reference))) {
			throw new CredentialHelperError("ALREADY_EXISTS");
		}
		const value = crypto.getRandomValues(new Uint8Array(32));
		this.keys.set(keyId(reference), value.slice());
		return value;
	}

	async deleteKey(reference: CredentialKeyReference): Promise<{ deleted: boolean }> {
		return { deleted: this.keys.delete(keyId(reference)) };
	}
}

function createRepository(): EncryptedAgentRepository {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-host-services-"));
	temporaryDirectories.push(directory);
	return new EncryptedAgentRepository({
		databasePath: join(directory, "agent.sqlite3"),
		installationId: "install-1",
		keyStore: new MemoryKeyStore(),
	});
}

function keyId(reference: CredentialKeyReference): string {
	return `${reference.installationId}:${reference.accountId}:${reference.keyVersion}`;
}
