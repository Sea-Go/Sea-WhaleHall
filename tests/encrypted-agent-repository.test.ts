import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeLegacyActivityPolicyCutover } from "../src/bun/activity-window-policy-cutover";
import { AgentToolPolicy, digestArguments } from "../src/bun/agent-tool-policy";
import {
	CredentialHelperError,
	type CredentialKeyReference,
	type CredentialKeyStore,
} from "../src/bun/credential-helper-client";
import {
	completeDataCenterRegistration,
	createDataCenterAgentCredentials,
	createDataCenterConsumerAudit,
	createPendingDataCenterAdvance,
	createPendingDataCenterBatch,
} from "../src/bun/data-center-contract";
import {
	AgentPermissionRevisionConflictError,
	CalendarRevisionConflictError,
	EncryptedAgentRepository,
	ProactiveFeedbackPolicyDisabledError,
	ProactiveFeedbackPolicyRevisionConflictError,
} from "../src/bun/encrypted-agent-repository";
import { planningDraftDigest } from "../src/bun/planning-authority-digest";
import type { CalendarEvent } from "../src/shared/calendar";
import type { PlanningAuthoritySnapshot } from "../src/shared/planning-authority";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("EncryptedAgentRepository", () => {
	test("creates workflows without overwrite and updates them with an exact CAS version", async () => {
		const { repository } = createRepository(new MemoryKeyStore(), () => 10_000);
		const original = {
			accountId: "account-a",
			id: "draft-1",
			name: "agent-saved-draft",
			definition: { title: "初稿" },
			enabled: true,
			createdAtMs: 100,
			updatedAtMs: 100,
		};
		await expect(
			repository.compareAndSetWorkflow(original, null),
		).resolves.toBe(true);
		await expect(
			repository.compareAndSetWorkflow(
				{
					...original,
					definition: { title: "不得覆盖" },
				},
				null,
			),
		).resolves.toBe(false);
		await expect(
			repository.getWorkflow("account-a", "draft-1"),
		).resolves.toEqual(original);

		const updated = {
			...original,
			definition: { title: "修订稿" },
			updatedAtMs: 101,
		};
		await expect(repository.compareAndSetWorkflow(updated, 99)).resolves.toBe(
			false,
		);
		await expect(repository.compareAndSetWorkflow(updated, 100)).resolves.toBe(
			true,
		);
		await expect(
			repository.getWorkflow("account-a", "draft-1"),
		).resolves.toEqual(updated);
		repository.close();
	});

	test("round-trips every base record while keeping sensitive values out of SQLite", async () => {
		const keys = new MemoryKeyStore();
		const { path, repository } = createRepository(keys, () => 10_000);
		const conversation = {
			accountId: "account-a",
			id: "conversation-1",
			title: "会话-plaintext-sentinel",
			createdAtMs: 1_000,
			updatedAtMs: 1_100,
		};
		const message = {
			accountId: "account-a",
			id: "message-1",
			conversationId: conversation.id,
			clientMessageId: "client-message-1",
			runId: "run-1",
			role: "assistant" as const,
			status: "complete" as const,
			content: "message-plaintext-sentinel",
			createdAtMs: 1_200,
		};
		const workflow = {
			accountId: "account-a",
			id: "workflow-1",
			name: "workflow-plaintext-sentinel",
			definition: { prompt: "definition-plaintext-sentinel" },
			enabled: true,
			createdAtMs: 1_300,
			updatedAtMs: 1_400,
		};
		const run = {
			accountId: "account-a",
			id: "run-1",
			conversationId: conversation.id,
			workflowId: workflow.id,
			status: "completed" as const,
			input: { text: "input-plaintext-sentinel" },
			output: { text: "output-plaintext-sentinel" },
			error: null,
			createdAtMs: 1_500,
			updatedAtMs: 1_600,
			completedAtMs: 1_600,
		};
		const eventRecord = {
			accountId: "account-a",
			event: timedEvent("event-1", "event-plaintext-sentinel"),
			updatedAtMs: 1_700,
		};

		await repository.putConversation(conversation);
		await repository.putMessage(message);
		await repository.putWorkflow(workflow);
		await repository.putRun(run);
		await repository.putCalendarEvent(eventRecord);
		await repository.setGrant("account-a", "agent.calendar.read");
		const policy = new AgentToolPolicy(repository, () => 2_000);
		const approval = await policy.proposeWrite({
			accountId: "account-a",
			runId: "run-1",
			toolCallId: "tool-1",
			toolName: "calendar.create_event",
			arguments: {
				event: timedEvent("approval-event", "approval-plaintext-sentinel"),
			},
			runRevision: 3,
		});

		for (const sentinel of [
			conversation.title,
			message.content,
			workflow.name,
			"definition-plaintext-sentinel",
			"input-plaintext-sentinel",
			"output-plaintext-sentinel",
			eventRecord.event.title,
			"2026-08-01T01:02:03.456Z",
			"approval-plaintext-sentinel",
		]) {
			expect(sqliteFilesContain(path, sentinel)).toBe(false);
		}

		repository.close();
		const reopened = new EncryptedAgentRepository({
			databasePath: path,
			installationId: "install-1",
			keyStore: keys,
		});
		await expect(
			reopened.getConversation("account-a", conversation.id),
		).resolves.toEqual(conversation);
		await expect(reopened.getMessage("account-a", message.id)).resolves.toEqual(
			message,
		);
		await expect(
			reopened.getWorkflow("account-a", workflow.id),
		).resolves.toEqual(workflow);
		await expect(reopened.getRun("account-a", run.id)).resolves.toEqual(run);
		await expect(
			reopened.getCalendarEvent("account-a", "event-1"),
		).resolves.toEqual(eventRecord);
		await expect(
			reopened.hasGrant("account-a", "agent.calendar.read"),
		).resolves.toBe(true);
		await expect(
			reopened.getApproval("account-a", approval.approvalId),
		).resolves.toEqual(
			expect.objectContaining({
				arguments: {
					event: expect.objectContaining({
						title: "approval-plaintext-sentinel",
					}),
				},
				status: "pending",
			}),
		);
		reopened.close();
	});

	test("encrypts DataCenter identity and exact pending wire state with one operation per account", async () => {
		const keys = new MemoryKeyStore();
		const { path, repository } = createRepository(keys, () => 20_000);
		const pendingCredentials = createDataCenterAgentCredentials({
			accountId: "account-a",
			installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			nowMs: 10_000,
			platform: "darwin",
		});
		const credentials = completeDataCenterRegistration(
			pendingCredentials,
			{
				agentId: "11111111-1111-4111-8111-111111111111",
				deviceId: "22222222-2222-4222-8222-222222222222",
				configVersion: 1,
			},
			11_000,
		);
		const secondCredentials = completeDataCenterRegistration(
			createDataCenterAgentCredentials({
				accountId: "account-b",
				installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				nowMs: 10_100,
				platform: "darwin",
			}),
			{
				agentId: "33333333-3333-4333-8333-333333333333",
				deviceId: "44444444-4444-4444-8444-444444444444",
				configVersion: 1,
			},
			11_100,
		);
		const batch = createPendingDataCenterBatch(
			"account-a",
			[
				{
					schemaVersion: "desktop-event.v1",
					eventId: `de1_${"a".repeat(64)}`,
					cursor: "ec1_0000000000000001",
					deviceId: "local-device",
					sessionId: "local-session",
					kind: "system.heartbeat",
					source: "test",
					occurredAtMs: 10_000,
					observedAtMs: 10_000,
					goalVersion: null,
					sensitivity: "metadata",
					payload: {},
				},
			],
			12_000,
		);
		await repository.putDataCenterAgentCredentials(credentials);
		await repository.putDataCenterAgentCredentials(secondCredentials);
		await repository.putDataCenterPendingBatch(batch);
		await repository.setDataCenterConsumerOwner("account-a");
		const audit = createDataCenterConsumerAudit({
			fromAccountId: "previous-account-sentinel",
			toAccountId: "account-a",
			fromCursor: null,
			toCursor: batch.lastCursor,
			boundaryEpochMs: 1,
			createdAtMs: 12_100,
		});
		await repository.appendDataCenterConsumerAudit(audit);
		await repository.appendDataCenterConsumerAudit(audit);

		const conflicting = { ...batch, batchKey: `${batch.batchKey}-other` };
		await expect(
			repository.putDataCenterPendingBatch(conflicting),
		).rejects.toThrow("already pending");
		await expect(
			repository.putDataCenterPendingAdvance(
				createPendingDataCenterAdvance({
					accountId: "account-a",
					fromCursor: null,
					toCursor: "ec1_0000000000000001",
					reason: "account-boundary",
					createdAtMs: 12_500,
				}),
			),
		).rejects.toThrow("already pending");
		for (const sentinel of [
			credentials.privateKeyPkcs8,
			credentials.registrationRequestBody,
			secondCredentials.privateKeyPkcs8,
			secondCredentials.registrationRequestBody,
			batch.body,
			"previous-account-sentinel",
		]) {
			expect(sqliteFilesContain(path, sentinel)).toBe(false);
		}

		repository.close();
		const reopened = new EncryptedAgentRepository({
			databasePath: path,
			installationId: "install-1",
			keyStore: keys,
		});
		await expect(
			reopened.getDataCenterAgentCredentials("account-a"),
		).resolves.toEqual(credentials);
		await expect(
			reopened.getDataCenterAgentCredentials("account-b"),
		).resolves.toEqual(secondCredentials);
		expect(secondCredentials.installationId).not.toBe(
			credentials.installationId,
		);
		expect(secondCredentials.privateKeyPkcs8).not.toBe(
			credentials.privateKeyPkcs8,
		);
		await expect(
			reopened.getDataCenterPendingBatch("account-a"),
		).resolves.toEqual(batch);
		expect(reopened.getDataCenterConsumerOwner()?.accountId).toBe("account-a");
		await expect(
			reopened.listDataCenterConsumerAudits("account-a"),
		).resolves.toEqual([audit]);
		const replacement = createPendingDataCenterAdvance({
			accountId: "account-a",
			fromCursor: null,
			toCursor: batch.lastCursor,
			reason: "retention-expired",
			createdAtMs: 12_900,
		});
		await expect(
			reopened.replaceDataCenterPendingBatchWithAdvance(batch, replacement),
		).resolves.toBe(true);
		await expect(
			reopened.getDataCenterPendingBatch("account-a"),
		).resolves.toBeNull();
		await expect(
			reopened.getDataCenterPendingAdvance("account-a"),
		).resolves.toEqual(replacement);
		expect(
			reopened.deleteDataCenterPendingAdvance(
				"account-a",
				replacement.advanceKey,
			),
		).toBe(true);
		const advance = createPendingDataCenterAdvance({
			accountId: "account-a",
			fromCursor: "ec1_0000000000000001",
			toCursor: "ec1_0000000000000003",
			reason: "retention-expired",
			createdAtMs: 13_000,
		});
		await reopened.putDataCenterPendingAdvance(advance);
		await expect(
			reopened.getDataCenterPendingAdvance("account-a"),
		).resolves.toEqual(advance);
		reopened.close();
	});

	test("enforces signed i64 cursors in encrypted DataCenter records", async () => {
		const { repository } = createRepository(new MemoryKeyStore(), () => 1_000);
		const maximumCursorBatch = createPendingDataCenterBatch(
			"account-a",
			[
				{
					schemaVersion: "desktop-event.v1",
					eventId: `de1_${"f".repeat(64)}`,
					cursor: "ec1_7fffffffffffffff",
					deviceId: "local-device",
					sessionId: "local-session",
					kind: "system.heartbeat",
					source: "test",
					occurredAtMs: 1_000,
					observedAtMs: 1_000,
					goalVersion: null,
					sensitivity: "metadata",
					payload: {},
				},
			],
			1_000,
		);
		await repository.putDataCenterPendingBatch(maximumCursorBatch);
		await expect(
			repository.getDataCenterPendingBatch("account-a"),
		).resolves.toEqual(maximumCursorBatch);
		await expect(
			repository.putDataCenterPendingBatch({
				...maximumCursorBatch,
				firstCursor: "ec1_8000000000000000",
				lastCursor: "ec1_8000000000000000",
			}),
		).rejects.toThrow("pending batch");
		repository.close();
	});

	test("prunes DataCenter consumer audits by age and count per owning account", async () => {
		const retentionMs = 31 * 24 * 60 * 60 * 1_000;
		let nowMs = 0;
		const { repository } = createRepository(new MemoryKeyStore(), () => nowMs);
		const audit = (accountId: string, sequence: number, createdAtMs: number) =>
			createDataCenterConsumerAudit({
				fromAccountId: null,
				toAccountId: accountId,
				fromCursor: null,
				toCursor: `ec1_${sequence.toString(16).padStart(16, "0")}`,
				boundaryEpochMs: sequence,
				createdAtMs,
			});

		const staleA = audit("account-a", 1, nowMs);
		const staleB = audit("account-b", 1, nowMs);
		await repository.appendDataCenterConsumerAudit(staleA);
		await repository.appendDataCenterConsumerAudit(staleB);

		nowMs = retentionMs + 1;
		const freshA = audit("account-a", 2, nowMs);
		await repository.appendDataCenterConsumerAudit(freshA);
		await expect(
			repository.listDataCenterConsumerAudits("account-a"),
		).resolves.toEqual([freshA]);
		await expect(
			repository.listDataCenterConsumerAudits("account-b"),
		).resolves.toEqual([staleB]);

		const freshB = audit("account-b", 2, nowMs);
		await repository.appendDataCenterConsumerAudit(freshB);
		await expect(
			repository.listDataCenterConsumerAudits("account-b"),
		).resolves.toEqual([freshB]);

		const capped: ReturnType<typeof audit>[] = [];
		for (let index = 0; index < 1_001; index += 1) {
			nowMs += 1;
			const record = audit("account-a", index + 10, nowMs);
			capped.push(record);
			await repository.appendDataCenterConsumerAudit(record);
		}
		const retained = await repository.listDataCenterConsumerAudits(
			"account-a",
			1_000,
		);
		expect(retained.map((record) => record.id)).toEqual(
			capped.slice(1).map((record) => record.id),
		);
		await expect(
			repository.listDataCenterConsumerAudits("account-b"),
		).resolves.toEqual([freshB]);
		repository.close();
	});

	test("enforces client-message idempotency and preserves partial message state", async () => {
		const { repository } = createRepository(new MemoryKeyStore());
		await repository.putConversation({
			accountId: "account-a",
			id: "conversation-1",
			title: "标题",
			createdAtMs: 1,
			updatedAtMs: 1,
		});
		const partial = {
			accountId: "account-a",
			id: "message-1",
			conversationId: "conversation-1",
			clientMessageId: "client-message-1",
			runId: "run-1",
			role: "assistant" as const,
			status: "partial" as const,
			content: "尚未完成",
			createdAtMs: 2,
		};
		await repository.putMessage(partial);
		await expect(
			repository.putMessage({ ...partial, id: "message-2" }),
		).rejects.toThrow();
		await expect(
			repository.getMessageByClientMessageId("account-a", "client-message-1"),
		).resolves.toEqual(partial);
		await expect(
			repository.listContextMessages("account-a", "conversation-1"),
		).resolves.toEqual([]);
		const complete = {
			...partial,
			status: "complete" as const,
			content: "已完成",
		};
		await repository.putMessage(complete);
		await expect(
			repository.getMessage("account-a", "message-1"),
		).resolves.toEqual(complete);
		await expect(
			repository.listContextMessages("account-a", "conversation-1"),
		).resolves.toEqual([complete]);
		repository.close();
	});

	test("updates both Agent read grants atomically with optimistic revision checks", async () => {
		const { repository } = createRepository(new MemoryKeyStore(), () => 30_000);
		await repository.ensureAccount("account-a");
		await expect(
			repository.getAgentReadPermissions("account-a"),
		).resolves.toEqual({
			grants: [],
			revision: 0,
			updatedAtMs: null,
		});

		await expect(
			repository.setAgentReadPermissions("account-a", true, 0),
		).resolves.toEqual({
			grants: ["agent.calendar.read", "agent.planning.read"],
			revision: 1,
			updatedAtMs: 30_000,
		});
		await expect(
			repository.setAgentReadPermissions("account-a", false, 0),
		).rejects.toEqual(
			expect.objectContaining({
				name: "AgentPermissionRevisionConflictError",
				actualRevision: 1,
			}),
		);
		await expect(
			repository.setAgentReadPermissions("account-a", false, 1),
		).resolves.toEqual({
			grants: [],
			revision: 2,
			updatedAtMs: 30_000,
		});
		await expect(
			repository.setAgentReadPermissions("account-a", true, 1),
		).rejects.toBeInstanceOf(AgentPermissionRevisionConflictError);
		await expect(
			repository.hasGrant("account-a", "agent.calendar.read"),
		).resolves.toBe(false);
		await expect(
			repository.hasGrant("account-a", "agent.planning.read"),
		).resolves.toBe(false);
		repository.close();
	});

	test("encrypts and queries opaque Mastra workflow snapshots", async () => {
		const { path, repository } = createRepository(new MemoryKeyStore());
		const record = {
			accountId: "account-a",
			workflowName: "task-planning",
			runId: "workflow-run-1",
			resourceId: "account-a",
			snapshot: {
				status: "suspended",
				context: {
					generate: { output: "workflow-snapshot-plaintext-sentinel" },
				},
			},
			createdAtMs: 40_000,
			updatedAtMs: 40_100,
		};
		await repository.putWorkflowSnapshot(record);
		expect(
			sqliteFilesContain(path, "workflow-snapshot-plaintext-sentinel"),
		).toBe(false);
		await expect(
			repository.getWorkflowSnapshot(
				"account-a",
				record.runId,
				record.workflowName,
			),
		).resolves.toEqual(record);
		await expect(
			repository.getWorkflowSnapshot("account-a", record.runId),
		).resolves.toEqual(record);
		await expect(
			repository.listWorkflowSnapshots("account-a", {
				workflowName: "task-planning",
				status: "suspended",
				fromDateMs: 39_000,
				toDateMs: 41_000,
				page: 0,
				perPage: 10,
			}),
		).resolves.toEqual({ runs: [record], total: 1 });
		await expect(
			repository.listWorkflowSnapshots("account-b", {
				resourceId: "account-a",
			}),
		).resolves.toEqual({ runs: [], total: 0 });
		await expect(
			repository.deleteWorkflowSnapshot(
				"account-a",
				record.runId,
				record.workflowName,
			),
		).resolves.toBe(true);
		await expect(
			repository.getWorkflowSnapshot(
				"account-a",
				record.runId,
				record.workflowName,
			),
		).resolves.toBeNull();
		repository.close();
	});

	test("commits calendar batches atomically with a date-only coarse index", async () => {
		const { path, repository } = createRepository(
			new MemoryKeyStore(),
			() => 20_000,
		);
		const first = {
			accountId: "account-a",
			event: timedEvent("event-1", "第一项"),
			updatedAtMs: 1,
		};
		const second = {
			accountId: "account-a",
			event: {
				...timedEvent("event-2", "第二项"),
				schedule: {
					allDay: false as const,
					start: "2026-08-02T15:30:00.000Z",
					end: "2026-08-02T16:00:00.000Z",
					timeZone: "Asia/Shanghai",
				},
			},
			updatedAtMs: 2,
		};
		const dstBoundary = {
			accountId: "account-a",
			event: {
				...timedEvent("event-dst", "夏令时边界"),
				schedule: {
					allDay: false as const,
					start: "2026-11-01T05:30:00.000Z",
					end: "2026-11-01T07:30:00.000Z",
					timeZone: "America/New_York",
				},
			},
			updatedAtMs: 3,
		};

		await expect(
			repository.commitCalendarBatch("account-a", {
				expectedRevision: 0,
				upserts: [first, second, dstBoundary],
				deletes: [],
			}),
		).resolves.toEqual({ revision: 1 });
		const inspected = new Database(path);
		expect(
			inspected
				.query(
					"SELECT start_date, end_date_exclusive FROM calendar_events WHERE account_id = ? AND event_id = ?",
				)
				.get("account-a", "event-1"),
		).toEqual({ start_date: "2026-08-01", end_date_exclusive: "2026-08-02" });
		expect(
			inspected
				.query(
					"SELECT event_id, start_date, end_date_exclusive FROM calendar_events WHERE account_id = ? AND event_id IN (?, ?) ORDER BY event_id",
				)
				.all("account-a", "event-2", "event-dst"),
		).toEqual([
			{
				event_id: "event-2",
				start_date: "2026-08-02",
				end_date_exclusive: "2026-08-03",
			},
			{
				event_id: "event-dst",
				start_date: "2026-11-01",
				end_date_exclusive: "2026-11-02",
			},
		]);
		inspected.close();
		expect(sqliteFilesContain(path, "2026-08-01T01:02:03.456Z")).toBe(false);

		await expect(
			repository.commitCalendarBatch("account-a", {
				expectedRevision: 0,
				upserts: [{ ...second, event: { ...second.event, title: "不应写入" } }],
				deletes: ["event-1"],
			}),
		).rejects.toBeInstanceOf(CalendarRevisionConflictError);
		await expect(repository.getCalendarRevision("account-a")).resolves.toBe(1);
		await expect(
			repository.getCalendarEvent("account-a", "event-1"),
		).resolves.toEqual(first);
		await expect(
			repository.commitCalendarBatch("account-a", {
				expectedRevision: 1,
				upserts: [{ ...second, event: { ...second.event, title: "已更新" } }],
				deletes: ["event-1"],
			}),
		).resolves.toEqual({ revision: 2 });
		await expect(
			repository.deleteCalendarEvent("account-a", "event-2"),
		).resolves.toBe(true);
		await expect(repository.getCalendarRevision("account-a")).resolves.toBe(3);
		repository.close();
	});

	test("commits calendar and planning authority atomically and keeps commit retries idempotent", async () => {
		const { path, repository } = createRepository(
			new MemoryKeyStore(),
			() => 60_000,
		);
		const draft = planningAuthorityDraft("draft-sentinel-one", 1, 0);
		await expect(
			repository.compareAndSetPlanningAuthority("account-a", draft, null),
		).resolves.toBe(true);
		await expect(
			repository.getPlanningAuthority("account-b"),
		).resolves.toBeNull();
		expect(sqliteFilesContain(path, "draft-sentinel-one")).toBe(false);

		const event = planEvent("proposal-1", "schedule-sentinel-one", "plan-1");
		const committed = committedPlanningAuthority(draft, {
			commitId: "commit-1",
			calendarRevision: 1,
		});
		const firstCommit = {
			commitId: "commit-1",
			expectedAuthorityRevision: 1,
			calendar: {
				expectedRevision: 0,
				upserts: [{ accountId: "account-a", event, updatedAtMs: 60_000 }],
				deletes: [],
			},
			authority: committed,
		};
		const concurrentRetry = structuredClone(firstCommit);
		concurrentRetry.calendar.upserts[0]!.updatedAtMs = 60_001;
		concurrentRetry.authority.updatedAtMs = 60_001;
		concurrentRetry.authority.commit!.committedAtMs = 60_001;
		const concurrentResults = await Promise.all([
			repository.commitCalendarAndPlanningAuthority("account-a", firstCommit),
			repository.commitCalendarAndPlanningAuthority(
				"account-a",
				concurrentRetry,
			),
		]);
		expect(concurrentResults.map((result) => result.idempotent).sort()).toEqual(
			[false, true],
		);
		expect(concurrentResults).toEqual([
			expect.objectContaining({ calendarRevision: 1, authorityRevision: 2 }),
			expect.objectContaining({ calendarRevision: 1, authorityRevision: 2 }),
		]);
		await expect(repository.getCalendarRevision("account-a")).resolves.toBe(1);
		await expect(
			repository.getCalendarEvent("account-a", event.id),
		).resolves.toEqual(
			expect.objectContaining({ accountId: "account-a", event }),
		);
		const persistedCommitted =
			await repository.getPlanningAuthority("account-a");
		expect(persistedCommitted).toEqual(
			expect.objectContaining({
				status: "committed",
				revision: 2,
				commit: expect.objectContaining({ commitId: "commit-1" }),
			}),
		);
		expect(sqliteFilesContain(path, "schedule-sentinel-one")).toBe(false);

		const appliedPreviousCommit = structuredClone(persistedCommitted!);
		appliedPreviousCommit.revision = 3;
		appliedPreviousCommit.updatedAtMs = 60_003;
		appliedPreviousCommit.commit!.effect = {
			status: "applied",
			attempts: 1,
			lastAttemptAtMs: 60_003,
			lastError: null,
		};
		await expect(
			repository.compareAndSetPlanningAuthority(
				"account-a",
				appliedPreviousCommit,
				2,
			),
		).resolves.toBe(true);
		const nextDraft = planningAuthorityDraft(
			"draft-sentinel-two",
			4,
			1,
			appliedPreviousCommit,
		);
		await expect(
			repository.compareAndSetPlanningAuthority("account-a", nextDraft, 3),
		).resolves.toBe(true);
		const secondEvent = planEvent(
			"proposal-2",
			"schedule-sentinel-two",
			"plan-2",
		);
		const secondCommitted = committedPlanningAuthority(nextDraft, {
			commitId: "commit-2",
			calendarRevision: 1,
		});
		const guardedCommit = committedPlanningAuthority(nextDraft, {
			commitId: "commit-session-changed",
			calendarRevision: 2,
		});
		await expect(
			repository.commitCalendarAndPlanningAuthority("account-a", {
				commitId: "commit-session-changed",
				expectedAuthorityRevision: 4,
				calendar: {
					expectedRevision: 1,
					upserts: [
						{ accountId: "account-a", event: secondEvent, updatedAtMs: 60_001 },
					],
					deletes: [],
				},
				authority: guardedCommit,
				beforeCommit: () => {
					throw new Error("session changed before transaction");
				},
			}),
		).rejects.toThrow("session changed before transaction");
		await expect(repository.getCalendarRevision("account-a")).resolves.toBe(1);
		await expect(
			repository.getCalendarEvent("account-a", secondEvent.id),
		).resolves.toBeNull();
		await expect(repository.getPlanningAuthority("account-a")).resolves.toEqual(
			nextDraft,
		);
		await expect(
			repository.commitCalendarAndPlanningAuthority("account-a", {
				commitId: "commit-2",
				expectedAuthorityRevision: 4,
				calendar: {
					expectedRevision: 0,
					upserts: [
						{ accountId: "account-a", event: secondEvent, updatedAtMs: 60_001 },
					],
					deletes: [],
				},
				authority: secondCommitted,
			}),
		).rejects.toBeInstanceOf(CalendarRevisionConflictError);
		await expect(repository.getCalendarRevision("account-a")).resolves.toBe(1);
		await expect(
			repository.getCalendarEvent("account-a", secondEvent.id),
		).resolves.toBeNull();
		await expect(repository.getPlanningAuthority("account-a")).resolves.toEqual(
			nextDraft,
		);

		const reusedCommitId = committedPlanningAuthority(nextDraft, {
			commitId: "commit-1",
			calendarRevision: 2,
		});
		await expect(
			repository.commitCalendarAndPlanningAuthority("account-a", {
				commitId: "commit-1",
				expectedAuthorityRevision: 4,
				calendar: {
					expectedRevision: 1,
					upserts: [
						{ accountId: "account-a", event: secondEvent, updatedAtMs: 60_002 },
					],
					deletes: [],
				},
				authority: reusedCommitId,
			}),
		).rejects.toEqual(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
		await expect(repository.getCalendarRevision("account-a")).resolves.toBe(1);
		await expect(repository.getPlanningAuthority("account-a")).resolves.toEqual(
			nextDraft,
		);
		const tamper = new Database(path);
		tamper
			.query(
				"UPDATE planning_authority SET last_commit_digest = ? WHERE account_id = ?",
			)
			.run("f".repeat(64), "account-a");
		tamper.close();
		await expect(repository.getPlanningAuthority("account-a")).rejects.toEqual(
			expect.objectContaining({ code: "DECRYPTION_FAILED" }),
		);
		repository.close();
	});

	test("uses account-bound AAD, never recreates a missing key, and consumes approval once", async () => {
		const keys = new MemoryKeyStore();
		const { path, repository } = createRepository(keys, () => 50_000);
		for (const accountId of ["account-a", "account-b"]) {
			await repository.putConversation({
				accountId,
				id: "conversation-1",
				title: "相同明文",
				createdAtMs: 1,
				updatedAtMs: 1,
			});
		}
		await repository.setGrant("account-b", "agent.planning.read");
		const policy = new AgentToolPolicy(repository, () => 50_000);
		const argumentsValue = {
			draft: { id: "approval-draft", title: "一次性审批" },
		};
		const proposal = await policy.proposeWrite({
			accountId: "account-b",
			runId: "run-1",
			toolCallId: "tool-1",
			toolName: "planning.save_draft",
			arguments: argumentsValue,
			runRevision: 7,
		});
		const decisions = await Promise.allSettled([
			policy.decide({
				accountId: "account-b",
				approvalId: proposal.approvalId,
				runId: "run-1",
				toolCallId: "tool-1",
				inputDigest: digestArguments(argumentsValue),
				runRevision: 7,
				decision: "approve-once",
			}),
			policy.decide({
				accountId: "account-b",
				approvalId: proposal.approvalId,
				runId: "run-1",
				toolCallId: "tool-1",
				inputDigest: digestArguments(argumentsValue),
				runRevision: 7,
				decision: "approve-once",
			}),
		]);
		expect(
			decisions.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);

		repository.close();
		const tamper = new Database(path);
		const source = tamper
			.query(
				"SELECT title_nonce, title_ciphertext FROM conversations WHERE account_id = 'account-b' AND conversation_id = 'conversation-1'",
			)
			.get() as { title_nonce: Uint8Array; title_ciphertext: Uint8Array };
		tamper
			.query(
				"UPDATE conversations SET title_nonce = ?, title_ciphertext = ? WHERE account_id = 'account-a' AND conversation_id = 'conversation-1'",
			)
			.run(source.title_nonce, source.title_ciphertext);
		tamper.close();

		const reopened = new EncryptedAgentRepository({
			databasePath: path,
			installationId: "install-1",
			keyStore: keys,
		});
		await expect(
			reopened.getConversation("account-a", "conversation-1"),
		).rejects.toEqual(expect.objectContaining({ code: "DECRYPTION_FAILED" }));
		await expect(
			reopened.getConversation("account-b", "conversation-1"),
		).resolves.toEqual(expect.objectContaining({ title: "相同明文" }));
		reopened.close();

		const createsBeforeMissingKey = keys.createCalls;
		keys.clear();
		const missingKey = new EncryptedAgentRepository({
			databasePath: path,
			installationId: "install-1",
			keyStore: keys,
		});
		await expect(
			missingKey.getConversation("account-b", "conversation-1"),
		).rejects.toEqual(expect.objectContaining({ code: "ACCOUNT_KEY_MISSING" }));
		expect(keys.createCalls).toBe(createsBeforeMissingKey);
		missingKey.close();
	});

	test("stores an account-scoped proactive policy with an exact revision CAS", async () => {
		const { repository } = createRepository(new MemoryKeyStore(), () => 10_000);
		await expect(
			repository.getProactiveFeedbackPolicy("account-a"),
		).resolves.toEqual({
			policy: { enabled: true, retention: 30 },
			revision: 0,
			updatedAtMs: null,
		});
		await expect(
			repository.setProactiveFeedbackPolicy(
				"account-a",
				{ enabled: true, retention: 90 },
				0,
			),
		).resolves.toEqual({
			policy: { enabled: true, retention: 90 },
			revision: 1,
			updatedAtMs: 10_000,
		});
		await expect(
			repository.setProactiveFeedbackPolicy(
				"account-a",
				{ enabled: false, retention: 90 },
				0,
			),
		).rejects.toBeInstanceOf(ProactiveFeedbackPolicyRevisionConflictError);
		await expect(
			repository.getProactiveFeedbackPolicy("account-b"),
		).resolves.toEqual(
			expect.objectContaining({
				policy: { enabled: true, retention: 30 },
				revision: 0,
			}),
		);
		repository.close();
	});

	test("persists a clear journal across restart and gates new proactive archives until completion", async () => {
		const keys = new MemoryKeyStore();
		const { path, repository } = createRepository(keys, () => 10_000);
		await repository.ensureAccount("account-a");
		const analysis = activityAnalysisFixture("stream-clear-journal");
		const archive = {
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "window-clear-journal",
			windowStartedAtMs: 1_000,
			windowEndedAtMs: 2_000,
			analysis,
			archivedAtMs: 3_000,
			consumedAtMs: null,
			consumedRunId: null,
		};
		await repository.archiveProactiveFeedbackEventStream(archive);
		await expect(
			repository.isProactiveFeedbackClearPending("account-a"),
		).resolves.toBe(false);
		await repository.beginProactiveFeedbackClear("account-a");
		await repository.beginProactiveFeedbackClear("account-a");
		await expect(
			repository.isProactiveFeedbackClearPending("account-a"),
		).resolves.toBe(true);
		expect(() =>
			repository.assertProactiveFeedbackAcceptingWork("account-a"),
		).toThrow(ProactiveFeedbackPolicyDisabledError);
		await expect(
			repository.archiveProactiveFeedbackEventStream(archive),
		).rejects.toBeInstanceOf(ProactiveFeedbackPolicyDisabledError);
		await expect(
			repository.archiveProactiveFeedbackEventStream({
				...archive,
				id: "stream-clear-journal-new",
				analysis: {
					...analysis,
					request_id: "stream-clear-journal-new",
				},
			}),
		).rejects.toBeInstanceOf(ProactiveFeedbackPolicyDisabledError);
		await expect(
			repository.clearPendingProactiveFeedbackData("account-a"),
		).rejects.toBeInstanceOf(ProactiveFeedbackPolicyDisabledError);
		const feedback = {
			id: "feedback-clear-journal",
			generatedAtMs: 10_000,
			message: "这条活动运行不得在清除标记后重新写入。",
		};
		await expect(
			repository.putRun(
				completedActivityRun(
					"account-a",
					"run-clear-journal",
					"job-clear-journal",
					analysis,
					feedback,
				),
			),
		).rejects.toBeInstanceOf(ProactiveFeedbackPolicyDisabledError);
		repository.close();

		const recovered = new EncryptedAgentRepository({
			databasePath: path,
			installationId: "install-1",
			keyStore: keys,
			now: () => 20_000,
		});
		await expect(
			recovered.isProactiveFeedbackClearPending("account-a"),
		).resolves.toBe(true);
		await recovered.clearProactiveFeedbackData("account-a");
		await expect(
			recovered.isProactiveFeedbackClearPending("account-a"),
		).resolves.toBe(true);
		await recovered.completeProactiveFeedbackClear("account-a");
		await recovered.completeProactiveFeedbackClear("account-a");
		await expect(
			recovered.isProactiveFeedbackClearPending("account-a"),
		).resolves.toBe(false);
		expect(recovered.assertProactiveFeedbackAcceptingWork("account-a")).toBe(1);
		await expect(
			recovered.archiveProactiveFeedbackEventStream(archive),
		).resolves.toEqual(archive);
		recovered.close();
	});

	test("rejects an activity write that spans an entire completed clear epoch", async () => {
		const { repository } = createRepository(new MemoryKeyStore(), () => 30_000);
		const analysis = activityAnalysisFixture("stream-clear-epoch-aba");
		const feedback = {
			id: "feedback-clear-epoch-aba",
			generatedAtMs: 30_000,
			message: "旧清除世代的异步写入不得复活。",
		};
		const staleRun = {
			...completedActivityRun(
				"account-a",
				"run-clear-epoch-aba",
				"job-clear-epoch-aba",
				analysis,
				feedback,
			),
			status: "running" as const,
			output: { kind: "activity-analysis", result: null },
			completedAtMs: null,
		};
		const prepareStarted = deferred();
		const releasePrepare = deferred();
		type MutablePreparation = {
			prepareRun(record: typeof staleRun): Promise<unknown>;
		};
		const mutable = repository as unknown as MutablePreparation;
		const originalPrepare = mutable.prepareRun.bind(repository);
		mutable.prepareRun = async (record) => {
			prepareStarted.resolve();
			await releasePrepare.promise;
			return originalPrepare(record);
		};
		const lateWrite = repository.putRun(staleRun);
		await prepareStarted.promise;
		await repository.beginProactiveFeedbackClear("account-a");
		await repository.clearProactiveFeedbackData("account-a");
		await repository.completeProactiveFeedbackClear("account-a");
		releasePrepare.resolve();
		await expect(lateWrite).rejects.toBeInstanceOf(
			ProactiveFeedbackPolicyDisabledError,
		);
		await expect(
			repository.getRun("account-a", staleRun.id),
		).resolves.toBeNull();

		const freshEpoch =
			repository.assertProactiveFeedbackAcceptingWork("account-a");
		await expect(
			repository.putRun({
				...staleRun,
				id: "run-clear-epoch-fresh",
				input: {
					...(staleRun.input as Record<string, unknown>),
					clearEpoch: freshEpoch,
				},
			}),
		).resolves.toEqual(
			expect.objectContaining({ id: "run-clear-epoch-fresh" }),
		);
		repository.close();
	});

	test("persists an incomplete pending reset across restart until all stores confirm cleanup", async () => {
		const keys = new MemoryKeyStore();
		const { path, repository } = createRepository(keys, () => 25_000);
		await repository.ensureAccount("account-a");
		await repository.beginProactiveFeedbackPendingReset("account-a");
		await repository.beginProactiveFeedbackPendingReset("account-a");
		await expect(
			repository.isProactiveFeedbackPendingReset("account-a"),
		).resolves.toBeTrue();
		expect(() =>
			repository.assertProactiveFeedbackAcceptingWork("account-a"),
		).toThrow(ProactiveFeedbackPolicyDisabledError);
		repository.close();

		const recovered = new EncryptedAgentRepository({
			databasePath: path,
			installationId: "install-1",
			keyStore: keys,
			now: () => 26_000,
		});
		await expect(
			recovered.isProactiveFeedbackPendingReset("account-a"),
		).resolves.toBeTrue();
		await recovered.clearPendingProactiveFeedbackData("account-a");
		await recovered.completeProactiveFeedbackPendingReset("account-a");
		await expect(
			recovered.isProactiveFeedbackPendingReset("account-a"),
		).resolves.toBeFalse();
		expect(recovered.assertProactiveFeedbackAcceptingWork("account-a")).toBe(1);
		recovered.close();
	});

	test("wraps the legacy Worker cutover in the real durable reset journal", async () => {
		const { repository } = createRepository(new MemoryKeyStore(), () => 27_000);
		await repository.ensureAccount("account-a");
		let legacyState: "pending" | "complete" = "pending";
		const readLegacyState = (): "pending" | "complete" => legacyState;
		let sourceClears = 0;
		await completeLegacyActivityPolicyCutover(
			{
				getLegacyPolicyCutoverStatus: () => ({ state: legacyState }),
				clearLegacyPolicyCutoverWorkerData: () => undefined,
				markLegacyPolicyCutoverComplete: () => {
					legacyState = "complete";
					return true;
				},
			},
			{
				clearWindowsForAccount: async () => {
					sourceClears += 1;
				},
			},
			repository,
			"account-a",
		);
		expect(readLegacyState()).toBe("complete");
		expect(sourceClears).toBe(1);
		await expect(
			repository.isProactiveFeedbackPendingReset("account-a"),
		).resolves.toBeFalse();
		expect(repository.assertProactiveFeedbackAcceptingWork("account-a")).toBe(
			1,
		);
		repository.close();
	});

	test("atomically promotes a pending reset into the stronger full-clear journal", async () => {
		const { repository } = createRepository(new MemoryKeyStore(), () => 28_000);
		await repository.ensureAccount("account-a");
		await repository.beginProactiveFeedbackPendingReset("account-a");
		await repository.beginProactiveFeedbackClear("account-a");
		await repository.beginProactiveFeedbackClear("account-a");
		await expect(
			repository.isProactiveFeedbackPendingReset("account-a"),
		).resolves.toBeFalse();
		await expect(
			repository.isProactiveFeedbackClearPending("account-a"),
		).resolves.toBeTrue();
		await repository.clearProactiveFeedbackData("account-a");
		await repository.completeProactiveFeedbackClear("account-a");
		expect(repository.assertProactiveFeedbackAcceptingWork("account-a")).toBe(
			1,
		);
		repository.close();
	});

	test("upgrades schema v6 with the durable pending-reset journal", async () => {
		const keys = new MemoryKeyStore();
		const { path, repository } = createRepository(keys, () => 29_000);
		await repository.ensureAccount("account-a");
		repository.close();

		const legacy = new Database(path, { strict: true });
		legacy
			.query(
				"UPDATE encrypted_agent_schema SET version = 6 WHERE singleton = 1",
			)
			.run();
		legacy.exec("DROP TABLE proactive_feedback_pending_reset_journal;");
		legacy.close();

		const upgraded = new EncryptedAgentRepository({
			databasePath: path,
			installationId: "install-1",
			keyStore: keys,
			now: () => 30_000,
		});
		await upgraded.beginProactiveFeedbackPendingReset("account-a");
		await expect(
			upgraded.isProactiveFeedbackPendingReset("account-a"),
		).resolves.toBeTrue();
		upgraded.close();

		const verified = new Database(path, { readonly: true, strict: true });
		expect(
			verified
				.query("SELECT version FROM encrypted_agent_schema WHERE singleton = 1")
				.get(),
		).toEqual({ version: 7 });
		verified.close();
	});

	test("rotates the work epoch before an ordinary pending reset can be re-enabled", async () => {
		const { repository } = createRepository(new MemoryKeyStore(), () => 40_000);
		const analysis = activityAnalysisFixture("stream-pending-reset-aba");
		const feedback = {
			id: "feedback-pending-reset-aba",
			generatedAtMs: 40_000,
			message: "普通关闭前开始的异步写入不得在重新启用后复活。",
		};
		const staleRun = {
			...completedActivityRun(
				"account-a",
				"run-pending-reset-aba",
				"job-pending-reset-aba",
				analysis,
				feedback,
			),
			status: "running" as const,
			output: { kind: "activity-analysis", result: null },
			completedAtMs: null,
		};
		const prepareStarted = deferred();
		const releasePrepare = deferred();
		type MutablePreparation = {
			prepareRun(record: typeof staleRun): Promise<unknown>;
		};
		const mutable = repository as unknown as MutablePreparation;
		const originalPrepare = mutable.prepareRun.bind(repository);
		mutable.prepareRun = async (record) => {
			prepareStarted.resolve();
			await releasePrepare.promise;
			return originalPrepare(record);
		};

		const lateWrite = repository.putRun(staleRun);
		await prepareStarted.promise;
		await repository.setProactiveFeedbackPolicy(
			"account-a",
			{ enabled: false, retention: 30 },
			0,
		);
		await repository.beginProactiveFeedbackPendingReset("account-a");
		await repository.clearPendingProactiveFeedbackData("account-a");
		await repository.completeProactiveFeedbackPendingReset("account-a");
		await repository.setProactiveFeedbackPolicy(
			"account-a",
			{ enabled: true, retention: 30 },
			1,
		);
		releasePrepare.resolve();
		await expect(lateWrite).rejects.toBeInstanceOf(
			ProactiveFeedbackPolicyDisabledError,
		);
		await expect(
			repository.getRun("account-a", staleRun.id),
		).resolves.toBeNull();

		const freshEpoch =
			repository.assertProactiveFeedbackAcceptingWork("account-a");
		expect(freshEpoch).toBe(1);
		await expect(
			repository.putRun({
				...staleRun,
				id: "run-pending-reset-fresh",
				input: {
					...(staleRun.input as Record<string, unknown>),
					clearEpoch: freshEpoch,
				},
			}),
		).resolves.toEqual(
			expect.objectContaining({ id: "run-pending-reset-fresh" }),
		);
		repository.close();
	});

	test("rejects an archive read that spans an ordinary pending reset", async () => {
		const { repository } = createRepository(new MemoryKeyStore(), () => 50_000);
		await repository.ensureAccount("account-a");
		const analysis = activityAnalysisFixture("stream-archive-reset-aba");
		const archive = {
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "window-archive-reset-aba",
			windowStartedAtMs: 1_000,
			windowEndedAtMs: 2_000,
			analysis,
			archivedAtMs: 3_000,
			consumedAtMs: null,
			consumedRunId: null,
		};
		const readStarted = deferred();
		const releaseRead = deferred();
		const originalGet =
			repository.getProactiveFeedbackEventStream.bind(repository);
		repository.getProactiveFeedbackEventStream = async (
			accountId,
			streamId,
		) => {
			if (streamId === archive.id) {
				readStarted.resolve();
				await releaseRead.promise;
			}
			return originalGet(accountId, streamId);
		};

		const lateArchive = repository.archiveProactiveFeedbackEventStream(archive);
		await readStarted.promise;
		await repository.setProactiveFeedbackPolicy(
			"account-a",
			{ enabled: false, retention: 30 },
			0,
		);
		await repository.beginProactiveFeedbackPendingReset("account-a");
		await repository.clearPendingProactiveFeedbackData("account-a");
		await repository.completeProactiveFeedbackPendingReset("account-a");
		await repository.setProactiveFeedbackPolicy(
			"account-a",
			{ enabled: true, retention: 30 },
			1,
		);
		releaseRead.resolve();
		await expect(lateArchive).rejects.toBeInstanceOf(
			ProactiveFeedbackPolicyDisabledError,
		);
		await expect(originalGet("account-a", archive.id)).resolves.toBeNull();
		repository.close();
	});

	test("replays the archive-before-receipt crash gap by immutable identity", async () => {
		const keys = new MemoryKeyStore();
		const { path, repository } = createRepository(keys, () => 10_000);
		const analysis = activityAnalysisFixture("stream-crash-gap");
		const first = {
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "window-crash-gap",
			windowStartedAtMs: 1_000,
			windowEndedAtMs: 2_000,
			analysis,
			archivedAtMs: 3_000,
			consumedAtMs: null,
			consumedRunId: null,
		};
		await expect(
			repository.archiveProactiveFeedbackEventStream(first),
		).resolves.toEqual(first);
		repository.close();

		const recovered = new EncryptedAgentRepository({
			databasePath: path,
			installationId: "install-1",
			keyStore: keys,
			now: () => 20_000,
		});
		await expect(
			recovered.archiveProactiveFeedbackEventStream({
				...first,
				archivedAtMs: 20_000,
			}),
		).resolves.toEqual(first);
		await expect(
			recovered.archiveProactiveFeedbackEventStream({
				...first,
				analysis: { ...analysis, score_reason: "不同语义" },
				archivedAtMs: 20_000,
			}),
		).rejects.toEqual(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
		recovered.close();
	});

	test("atomically finalizes run, history, and streams while policy remains enabled", async () => {
		let now = 100_000;
		const { repository } = createRepository(new MemoryKeyStore(), () => now);
		const analysis = activityAnalysisFixture("stream-finalize");
		await repository.archiveProactiveFeedbackEventStream({
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "window-finalize",
			windowStartedAtMs: 1_000,
			windowEndedAtMs: 2_000,
			analysis,
			archivedAtMs: 1,
			consumedAtMs: null,
			consumedRunId: null,
		});
		const feedback = {
			id: "proactive-feedback-run-finalize",
			generatedAtMs: now,
			message: "主题：专注开发。分数已达到反馈阈值；可以谨慎核对下一步。",
		};
		const run = completedActivityRun(
			"account-a",
			"run-finalize",
			"job-finalize",
			analysis,
			feedback,
		);
		await expect(
			repository.completeProactiveFeedbackRun({
				run,
				sourceStreamIds: [analysis.request_id],
				feedback,
			}),
		).resolves.toEqual(feedback);
		await expect(
			repository.verifyCompletedProactiveFeedbackRun({
				accountId: "account-a",
				runId: run.id,
				jobId: "job-finalize",
				originatingRequestId: `request-${run.id}`,
				consumedScore: analysis.score,
				analyses: [analysis],
			}),
		).resolves.toBeTrue();
		await expect(
			repository.verifyCompletedProactiveFeedbackRun({
				accountId: "account-a",
				runId: run.id,
				jobId: "job-finalize",
				originatingRequestId: "different-semantic-request",
				consumedScore: analysis.score,
				analyses: [analysis],
			}),
		).resolves.toBeFalse();
		await expect(
			repository.verifyCompletedProactiveFeedbackRun({
				accountId: "account-a",
				runId: run.id,
				jobId: "job-finalize",
				originatingRequestId: `request-${run.id}`,
				consumedScore: analysis.score,
				analyses: [
					{
						...analysis,
						score_reason: "同一来源 ID 下的不同正文",
					},
				],
			}),
		).resolves.toBeFalse();
		await expect(
			repository.listProactiveFeedback("account-a"),
		).resolves.toEqual({
			items: [feedback],
			nextCursor: null,
		});
		await expect(
			repository.listProactiveFeedback("account-b"),
		).resolves.toEqual({
			items: [],
			nextCursor: null,
		});
		await expect(
			repository.deleteActivityAnalysisRuns("account-a", [run.id]),
		).resolves.toBe(0);
		await expect(repository.getRun("account-a", run.id)).resolves.toEqual(run);
		const changedFeedback = {
			...feedback,
			message: "同一 ID 下的不同正文不得静默成功。",
		};
		await expect(
			repository.completeProactiveFeedbackRun({
				run: completedActivityRun(
					"account-a",
					run.id,
					"job-finalize",
					analysis,
					changedFeedback,
				),
				sourceStreamIds: [analysis.request_id],
				feedback: changedFeedback,
			}),
		).rejects.toEqual(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

		// Retention is anchored at consumption/completion, never the old archive time.
		now += 29 * 24 * 60 * 60 * 1_000;
		await expect(
			repository.cleanupProactiveFeedback("account-a", now),
		).resolves.toEqual({
			deletedEventStreamCount: 0,
			deletedHistoryCount: 0,
		});
		now += 2 * 24 * 60 * 60 * 1_000;
		await expect(
			repository.cleanupProactiveFeedback("account-a", now, [run.id, run.id]),
		).resolves.toEqual({
			deletedEventStreamCount: 0,
			deletedHistoryCount: 0,
		});
		await expect(
			repository.verifyCompletedProactiveFeedbackRun({
				accountId: "account-a",
				runId: run.id,
				jobId: "job-finalize",
				originatingRequestId: `request-${run.id}`,
				consumedScore: analysis.score,
				analyses: [analysis],
			}),
		).resolves.toBeTrue();
		await expect(
			repository.cleanupProactiveFeedback("account-a", now),
		).resolves.toEqual({
			deletedEventStreamCount: 1,
			deletedHistoryCount: 1,
		});
		repository.close();
	});

	test("paginates more than twenty feedback rows generated in the same millisecond", async () => {
		const generatedAtMs = 200_000;
		const { repository } = createRepository(
			new MemoryKeyStore(),
			() => generatedAtMs,
		);
		for (let index = 0; index < 21; index += 1) {
			const suffix = index.toString().padStart(2, "0");
			const analysis = activityAnalysisFixture(`stream-page-${suffix}`);
			await repository.archiveProactiveFeedbackEventStream({
				accountId: "account-a",
				id: analysis.request_id,
				sourceWindowId: `window-page-${suffix}`,
				windowStartedAtMs: 1_000,
				windowEndedAtMs: 2_000,
				analysis,
				archivedAtMs: generatedAtMs - 1,
				consumedAtMs: null,
				consumedRunId: null,
			});
			const feedback = {
				id: `feedback-page-${suffix}`,
				generatedAtMs,
				message: `主动反馈 ${suffix}`,
			};
			const run = completedActivityRun(
				"account-a",
				`run-page-${suffix}`,
				`job-page-${suffix}`,
				analysis,
				feedback,
			);
			await repository.completeProactiveFeedbackRun({
				run,
				sourceStreamIds: [analysis.request_id],
				feedback,
			});
		}

		const first = await repository.listProactiveFeedback("account-a", {
			limit: 20,
		});
		expect(first.items).toHaveLength(20);
		expect(first.nextCursor).toEqual(
			expect.objectContaining({ generatedAtMs }),
		);
		const second = await repository.listProactiveFeedback("account-a", {
			limit: 20,
			cursor: first.nextCursor!,
		});
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		const ids = [...first.items, ...second.items].map((item) => item.id);
		expect(new Set(ids).size).toBe(21);
		expect(ids).toEqual([...ids].sort().reverse());
		repository.close();
	});

	test("sweeps only old history-free activity run orphans under forever retention", async () => {
		const dayMs = 24 * 60 * 60 * 1_000;
		let now = 3 * dayMs;
		const { path, repository } = createRepository(
			new MemoryKeyStore(),
			() => now,
		);
		await repository.setProactiveFeedbackPolicy(
			"account-a",
			{ enabled: true, retention: "forever" },
			0,
		);
		const analysis = activityAnalysisFixture("stream-orphan-history");
		const activityRun = (suffix: string, updatedAtMs: number) => {
			const jobId = `activity_analysis_${suffix}`;
			return {
				accountId: "account-a",
				id: `activity-run-${jobId}-1-${suffix}`,
				conversationId: null,
				workflowId: jobId,
				status: "failed" as const,
				input: {
					kind: "activity-analysis",
					jobId,
					requestId: `activity-request-${suffix}`,
					consumedScore: analysis.score,
					analyses: [structuredClone(analysis)],
				},
				output: null,
				error: { code: "MODEL_RELAY_UNAVAILABLE" },
				createdAtMs: Math.max(0, updatedAtMs - 1),
				updatedAtMs,
				completedAtMs: updatedAtMs,
			};
		};
		const direct = activityRun("direct-delete", 1_000);
		const orphan = activityRun("orphan", 1_001);
		const protectedRun = activityRun("protected", 1_002);
		const recent = activityRun("recent", now - 1_000);
		const decoy = {
			...activityRun("planning-decoy", 1_003),
			input: { kind: "task-planning" },
		};
		const corruptNoncandidate = {
			...activityRun("corrupt-noncandidate", 1_004),
			// These near-prefixes matched the old SQL LIKE underscores. GLOB keeps
			// this unrelated corrupt row outside the decrypt candidate set.
			id: "activity-run-activityXanalysis_corrupt-1-noncandidate",
			workflowId: "activityXanalysis_corrupt",
			input: { kind: "task-planning" },
		};
		for (const run of [
			direct,
			orphan,
			protectedRun,
			recent,
			decoy,
			corruptNoncandidate,
		]) {
			await repository.putRun(run);
		}

		await repository.archiveProactiveFeedbackEventStream({
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "window-orphan-history",
			windowStartedAtMs: 100,
			windowEndedAtMs: 200,
			analysis,
			archivedAtMs: 300,
			consumedAtMs: null,
			consumedRunId: null,
		});
		const historyRunId = "activity-run-activity_analysis_history-1-history";
		const historyFeedback = {
			id: `proactive-feedback-${historyRunId}`,
			generatedAtMs: 1_000,
			message: "已完成且有历史引用的主动反馈不得作为孤儿删除。",
		};
		const historyRun = completedActivityRun(
			"account-a",
			historyRunId,
			"activity_analysis_history",
			analysis,
			historyFeedback,
		);
		await repository.completeProactiveFeedbackRun({
			run: historyRun,
			sourceStreamIds: [analysis.request_id],
			feedback: historyFeedback,
		});

		const corrupt = new Database(path, { strict: true });
		corrupt
			.query(
				`UPDATE agent_runs SET input_ciphertext = ?
				 WHERE account_id = ? AND run_id = ?`,
			)
			.run(Uint8Array.of(0, 1, 2, 3), "account-a", corruptNoncandidate.id);
		corrupt.close();

		await expect(
			repository.deleteActivityAnalysisRuns("account-a", [direct.id, decoy.id]),
		).resolves.toBe(1);
		await expect(repository.getRun("account-a", direct.id)).resolves.toBeNull();
		await expect(repository.getRun("account-a", decoy.id)).resolves.toEqual(
			decoy,
		);
		await expect(
			repository.deleteActivityAnalysisRuns("account-a", [historyRun.id]),
		).resolves.toBe(0);

		await expect(
			repository.cleanupProactiveFeedback("account-a", now, [protectedRun.id]),
		).resolves.toEqual({
			deletedEventStreamCount: 0,
			deletedHistoryCount: 0,
		});
		await expect(repository.getRun("account-a", orphan.id)).resolves.toBeNull();
		await expect(
			repository.getRun("account-a", protectedRun.id),
		).resolves.toEqual(protectedRun);
		await expect(repository.getRun("account-a", recent.id)).resolves.toEqual(
			recent,
		);
		await expect(repository.getRun("account-a", decoy.id)).resolves.toEqual(
			decoy,
		);
		await expect(
			repository.getRun("account-a", historyRun.id),
		).resolves.toEqual(historyRun);

		const inspect = new Database(path, { strict: true });
		const corruptRow = inspect
			.query(
				"SELECT COUNT(*) AS count FROM agent_runs WHERE account_id = ? AND run_id = ?",
			)
			.get("account-a", corruptNoncandidate.id) as { count: number };
		inspect.close();
		expect(corruptRow.count).toBe(1);

		now += dayMs + 1;
		await expect(
			repository.cleanupProactiveFeedback("account-a", now),
		).resolves.toEqual({
			deletedEventStreamCount: 0,
			deletedHistoryCount: 0,
		});
		await expect(
			repository.getRun("account-a", protectedRun.id),
		).resolves.toBeNull();
		await expect(repository.getRun("account-a", recent.id)).resolves.toBeNull();
		await expect(repository.getRun("account-a", decoy.id)).resolves.toEqual(
			decoy,
		);
		await expect(
			repository.getRun("account-a", historyRun.id),
		).resolves.toEqual(historyRun);
		await expect(
			repository.listProactiveFeedback("account-a"),
		).resolves.toEqual({
			items: [historyFeedback],
			nextCursor: null,
		});
		repository.close();
	});

	test("fails closed when policy is disabled between archive and finalize", async () => {
		const { repository } = createRepository(
			new MemoryKeyStore(),
			() => 100_000,
		);
		const analysis = activityAnalysisFixture("stream-policy-race");
		await repository.archiveProactiveFeedbackEventStream({
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "window-policy-race",
			windowStartedAtMs: 1_000,
			windowEndedAtMs: 2_000,
			analysis,
			archivedAtMs: 3_000,
			consumedAtMs: null,
			consumedRunId: null,
		});
		const feedback = {
			id: "feedback-policy-race",
			generatedAtMs: 100_000,
			message: "策略关闭后不得产生这条历史。",
		};
		const runningActivity = {
			...completedActivityRun(
				"account-a",
				"run-policy-race",
				"job-policy-race",
				analysis,
				feedback,
			),
			status: "running" as const,
			output: { kind: "activity-analysis", result: null },
			completedAtMs: null,
		};
		await repository.putRun(runningActivity);
		const planningRun = {
			...runningActivity,
			id: "planning-run-preserved",
			workflowId: "planning-workflow",
			input: { kind: "task-planning" },
			output: { kind: "task-planning" },
		};
		await repository.putRun(planningRun);
		await repository.setProactiveFeedbackPolicy(
			"account-a",
			{ enabled: false, retention: 30 },
			0,
		);
		await expect(
			repository.completeProactiveFeedbackRun({
				run: completedActivityRun(
					"account-a",
					"run-policy-race",
					"job-policy-race",
					analysis,
					feedback,
				),
				sourceStreamIds: [analysis.request_id],
				feedback,
			}),
		).rejects.toBeInstanceOf(ProactiveFeedbackPolicyDisabledError);
		await expect(
			repository.listProactiveFeedback("account-a"),
		).resolves.toEqual({
			items: [],
			nextCursor: null,
		});
		await expect(
			repository.getProactiveFeedbackEventStream(
				"account-a",
				analysis.request_id,
			),
		).resolves.toEqual(expect.objectContaining({ consumedAtMs: null }));
		await repository.beginProactiveFeedbackPendingReset("account-a");
		await expect(
			repository.clearPendingProactiveFeedbackData("account-a"),
		).resolves.toEqual({
			clearedAtMs: 100_000,
			deletedEventStreamCount: 1,
			deletedRunCount: 1,
		});
		await repository.completeProactiveFeedbackPendingReset("account-a");
		await expect(
			repository.getRun("account-a", runningActivity.id),
		).resolves.toBeNull();
		await expect(
			repository.getRun("account-a", planningRun.id),
		).resolves.toEqual(planningRun);
		repository.close();
	});
});

class MemoryKeyStore implements CredentialKeyStore {
	private readonly keys = new Map<string, Uint8Array>();
	createCalls = 0;

	async getKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const key = this.keys.get(referenceKey(reference));
		if (!key) throw new CredentialHelperError("NOT_FOUND");
		return key.slice();
	}

	async createKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const id = referenceKey(reference);
		if (this.keys.has(id)) throw new CredentialHelperError("ALREADY_EXISTS");
		this.createCalls += 1;
		const key = Uint8Array.from(
			{ length: 32 },
			(_, index) => (this.createCalls * 41 + index * 13) & 0xff,
		);
		this.keys.set(id, key);
		return key.slice();
	}

	async deleteKey(
		reference: CredentialKeyReference,
	): Promise<{ deleted: boolean }> {
		return { deleted: this.keys.delete(referenceKey(reference)) };
	}

	clear(): void {
		for (const key of this.keys.values()) key.fill(0);
		this.keys.clear();
	}
}

function referenceKey(reference: CredentialKeyReference): string {
	return `${reference.installationId}:${reference.accountId}:v${reference.keyVersion}`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function createRepository(
	keyStore: CredentialKeyStore,
	now?: () => number,
): { path: string; repository: EncryptedAgentRepository } {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-encrypted-agent-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "agent.sqlite3");
	return {
		path,
		repository: new EncryptedAgentRepository({
			databasePath: path,
			installationId: "install-1",
			keyStore,
			now,
		}),
	};
}

function activityAnalysisFixture(requestId: string) {
	return {
		request_id: requestId,
		events: [
			{
				time: "00:00:01-00:00:02",
				action: "确定：正在进行开发",
				source_event_ids: ["window-source"],
				activity: "development",
				goal_relevance: "direct",
				confidence: 0.9,
				reason_codes: ["editor_activity"],
				evidence: ["编辑器活动"],
				started_at_ms: 1_000,
				ended_at_ms: 2_000,
			},
		],
		score: 1,
		score_reason: "与当前目标直接相关",
	};
}

function completedActivityRun(
	accountId: string,
	runId: string,
	jobId: string,
	analysis: ReturnType<typeof activityAnalysisFixture>,
	feedback: { id: string; generatedAtMs: number; message: string },
) {
	return {
		accountId,
		id: runId,
		conversationId: null,
		workflowId: jobId,
		status: "completed" as const,
		input: {
			kind: "activity-analysis",
			jobId,
			requestId: `request-${runId}`,
			consumedScore: analysis.score,
			analyses: [structuredClone(analysis)],
		},
		output: {
			kind: "activity-analysis",
			result: feedback.message,
		},
		error: null,
		createdAtMs: feedback.generatedAtMs - 1,
		updatedAtMs: feedback.generatedAtMs,
		completedAtMs: feedback.generatedAtMs,
	};
}

function timedEvent(id: string, title: string): CalendarEvent {
	return {
		id,
		title,
		kind: "manual-block",
		state: "committed",
		schedule: {
			allDay: false,
			start: "2026-08-01T01:02:03.456Z",
			end: "2026-08-01T02:03:04.567Z",
			timeZone: "Asia/Shanghai",
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: null,
		editable: true,
		version: 1,
	};
}

function planEvent(
	id: string,
	title: string,
	sourcePlanId: string,
): CalendarEvent {
	return {
		...timedEvent(id, title),
		kind: "plan",
		sourcePlanId,
		version: 0,
	};
}

function planningAuthorityDraft(
	goal: string,
	revision: number,
	calendarRevision: number,
	previous?: PlanningAuthoritySnapshot,
): PlanningAuthoritySnapshot {
	const planId = revision === 1 ? "plan-1" : "plan-2";
	const proposalId = revision === 1 ? "proposal-1" : "proposal-2";
	const taskId = revision === 1 ? "task-1" : "task-2";
	return {
		schemaVersion: "planning-authority.v1",
		revision,
		status: "draft",
		input: {
			goal,
			type: "short-term",
			deadline: "2026-08-31",
			priority: "high",
			weeklyCapacityHours: 8,
			unavailableDays: [],
			preferredSessionMinutes: 60,
			preferredDayPart: "morning",
		},
		draft: {
			plan: {
				id: planId,
				type: "short-term",
				title: goal,
				goal,
				deadline: "2026-08-31",
				priority: "high",
				weeklyCapacityHours: 8,
				calendarRevision,
				totalEstimatedMinutes: 60,
				phases: [{ id: "phase-1", title: "阶段", objective: goal, order: 1 }],
				milestones: [],
				tasks: [
					{
						id: taskId,
						phaseId: "phase-1",
						milestoneId: null,
						title: goal,
						estimatedMinutes: 60,
					},
				],
				scheduleWindow: {
					startDate: "2026-08-01",
					endDateExclusive: "2026-09-01",
				},
				generationRun: {
					id: `run-${revision}`,
					startedAt: "2026-08-01T00:00:00.000Z",
					completedAt: "2026-08-01T00:01:00.000Z",
					statuses: ["understood", "ready"],
					revision: 1,
				},
			},
			proposals: [
				{
					id: proposalId,
					sourcePlanId: planId,
					taskId,
					title: goal,
					state: "proposed",
					start: "2026-08-01T01:02:03.456Z",
					end: "2026-08-01T02:03:04.567Z",
					timeZone: "Asia/Shanghai",
					version: 0,
				},
			],
			busyWindows: [],
			conflicts: [],
			suggestions: [],
		},
		confirmedPlan: previous?.confirmedPlan ?? null,
		activeGoal: previous?.activeGoal ?? null,
		commit: previous?.commit ?? null,
		updatedAtMs: 60_000 + revision,
	};
}

function committedPlanningAuthority(
	draft: PlanningAuthoritySnapshot,
	options: { commitId: string; calendarRevision: number },
): PlanningAuthoritySnapshot {
	return {
		...structuredClone(draft),
		revision: draft.revision + 1,
		status: "committed",
		confirmedPlan: structuredClone(draft.draft.plan),
		activeGoal: {
			schemaVersion: "active-goal.v1",
			goalId: draft.draft.plan.id,
			planId: draft.draft.plan.id,
			version: (draft.activeGoal?.version ?? 0) + 1,
			text: draft.input.goal,
			activatedAtMs: 60_000,
		},
		commit: {
			commitId: options.commitId,
			draftRevision: draft.revision,
			draftDigest: planningDraftDigest(draft.input, draft.draft),
			calendarRevision: options.calendarRevision,
			committedAtMs: 60_000,
			committedCount: draft.draft.proposals.length,
			warnings: [],
			effect: {
				status: "pending",
				attempts: 0,
				lastAttemptAtMs: null,
				lastError: null,
			},
		},
		updatedAtMs: 60_000 + draft.revision + 1,
	};
}

function sqliteFilesContain(databasePath: string, value: string): boolean {
	const needle = Buffer.from(value, "utf8");
	return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
		.filter(existsSync)
		.some((path) => readFileSync(path).includes(needle));
}
