import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	type AgentHostMethod,
	type AgentRunEventFrame,
} from "../src/agent/mastra-host/protocol";
import {
	AgentRunCoordinator,
	type AgentSidecar,
} from "../src/bun/agent-run-coordinator";
import { AgentToolPolicy } from "../src/bun/agent-tool-policy";
import {
	CredentialHelperError,
	type CredentialKeyReference,
	type CredentialKeyStore,
} from "../src/bun/credential-helper-client";
import { EncryptedAgentRepository } from "../src/bun/encrypted-agent-repository";
import type { InternalAgentRunEventEnvelope } from "../src/shared/agent-runs";
import type {
	TaskPlanningDraft,
	TaskPlanningInput,
} from "../src/shared/task-planning";

const temporaryDirectories: string[] = [];
const openRepositories: EncryptedAgentRepository[] = [];

afterEach(() => {
	for (const repository of openRepositories.splice(0)) repository.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("AgentRunCoordinator", () => {
	test("stores a no-tool activity analysis locally without exposing it through renderer APIs", async () => {
		const harness = createHarness();
		const runId = "activity-run-private";
		await harness.coordinator.startActivityAnalysis({
			jobId: "activity-job-private",
			runId,
			requestId: "activity-request-private",
			consumedScore: 0,
			analyses: [
				{
					request_id: "worker-request-private",
					score: 0,
					score_reason: "goal-relevant activity",
					events: [
						{
							source_event_ids: ["sealed-window-only"],
							activity: "development",
							goal_relevance: "direct",
							confidence: 0.9,
							reason_codes: ["worker"],
							evidence: ["Worker summary only"],
							started_at_ms: 1,
							ended_at_ms: 2,
						},
					],
				},
			],
		});
		expect(harness.sidecar.calls).toEqual([
			expect.objectContaining({ method: "activity.start" }),
		]);
		expect(JSON.stringify(harness.sidecar.calls[0]?.params)).not.toContain(
			"raw_event",
		);
		expect(harness.coordinator.modelPurposeForRun(runId)).toBe("activity");

		harness.coordinator.acceptSidecarEvent(
			runEvent(runId, 1, { kind: "run.started", runKind: "activity" }, null),
		);
		harness.coordinator.acceptSidecarEvent(
			runEvent(
				runId,
				2,
				{
					kind: "run.completed",
					result: { summary: "开发活动与当前目标直接相关，建议继续当前任务。" },
				},
				"completed",
			),
		);
		await waitFor(
			async () =>
				(await harness.repository.getRun("account-a", runId))?.status ===
				"completed",
		);
		const persisted = await harness.repository.getRun("account-a", runId);
		expect(persisted?.input).toEqual(
			expect.objectContaining({
				kind: "activity-analysis",
				consumedScore: 0,
			}),
		);
		expect(JSON.stringify(persisted?.input)).not.toContain("raw_event");
		expect(JSON.stringify(persisted?.output)).toContain("建议继续当前任务");
		await expect(
			harness.coordinator.getAgentRunSnapshot(runId),
		).resolves.toEqual(expect.objectContaining({ kind: "not-found" }));
		await expect(
			harness.coordinator.listRestorableAgentRuns({}),
		).resolves.toEqual({
			kind: "success",
			data: { runs: [] },
		});
		expect(harness.activityTerminals).toEqual([
			expect.objectContaining({
				jobId: "activity-job-private",
				runId,
				accountId: "account-a",
				status: "completed",
			}),
		]);
	});

	test("lists a still-running active turn as restorable in the same Bun process", async () => {
		const harness = createHarness();
		const started = await harness.coordinator.startConversationTurn({
			requestId: "request-active-restorable",
			clientMessageId: "client-active-restorable",
			text: "保持这个运行可恢复",
		});
		if (started.kind !== "success")
			throw new Error("active run was not accepted");
		expect(harness.coordinator.modelPurposeForRun(started.data.runId)).toBe(
			"agent",
		);

		harness.coordinator.acceptSidecarEvent(
			runEvent(
				started.data.runId,
				1,
				{
					kind: "run.started",
					runKind: "conversation",
				},
				null,
			),
		);
		await waitFor(
			async () =>
				(await harness.repository.getRun("account-a", started.data.runId))
					?.status === "running",
		);

		const conversation = (
			await harness.repository.listConversations("account-a")
		)[0]!;
		const result = await harness.coordinator.listRestorableAgentRuns({
			kind: "conversation-turn",
			conversationId: conversation.id,
		});

		expect(result).toEqual({
			kind: "success",
			data: {
				runs: [
					expect.objectContaining({
						runId: started.data.runId,
						conversationId: conversation.id,
						status: "running",
					}),
				],
			},
		});
		expect(harness.sidecar.tracked.has(started.data.runId)).toBe(true);
		await expect(
			harness.coordinator.getAgentRunSnapshot(started.data.runId),
		).resolves.toEqual({
			kind: "success",
			data: expect.objectContaining({ status: "running" }),
		});
	});

	test("isolates active and persisted runs by the Bun-authenticated account", async () => {
		const harness = createHarness();
		const accountA = await harness.coordinator.startConversationTurn({
			requestId: "request-a",
			clientMessageId: "same-client-message",
			text: "账号 A 的私有消息",
		});
		if (accountA.kind !== "success") throw new Error(JSON.stringify(accountA));
		expect(accountA.kind).toBe("success");

		harness.account.current = "account-b";
		harness.account.generation += 1;
		await expect(
			harness.coordinator.getAgentRunSnapshot(accountA.data.runId),
		).resolves.toEqual(expect.objectContaining({ kind: "not-found" }));
		const accountB = await harness.coordinator.startConversationTurn({
			requestId: "request-b",
			clientMessageId: "same-client-message",
			text: "账号 B 的私有消息",
		});
		expect(accountB.kind).toBe("success");
		if (accountB.kind !== "success")
			throw new Error("account B run was not accepted");
		expect(accountB.data.runId).not.toBe(accountA.data.runId);

		const conversationsA =
			await harness.repository.listConversations("account-a");
		const conversationsB =
			await harness.repository.listConversations("account-b");
		expect(conversationsA).toHaveLength(1);
		expect(conversationsB).toHaveLength(1);
		expect(
			(
				await harness.repository.listMessages(
					"account-a",
					conversationsA[0]!.id,
				)
			).map((message) => message.content),
		).toContain("账号 A 的私有消息");
		expect(
			(
				await harness.repository.listMessages(
					"account-b",
					conversationsB[0]!.id,
				)
			).map((message) => message.content),
		).not.toContain("账号 A 的私有消息");

		harness.account.current = "account-a";
		harness.account.generation += 1;
		await expect(
			harness.coordinator.getAgentRunSnapshot(accountB.data.runId),
		).resolves.toEqual(expect.objectContaining({ kind: "not-found" }));
	});

	test("waits for an in-flight start during logout and never dispatches it after session invalidation", async () => {
		const harness = createHarness();
		const readStarted = deferred();
		const releaseRead = deferred();
		const originalRead = harness.repository.getMessageByClientMessageId.bind(
			harness.repository,
		);
		harness.repository.getMessageByClientMessageId = async (...args) => {
			readStarted.resolve();
			await releaseRead.promise;
			return originalRead(...args);
		};

		const starting = harness.coordinator.startConversationTurn({
			requestId: "request-start-logout-race",
			clientMessageId: "client-start-logout-race",
			text: "不要在退出后启动",
		});
		await readStarted.promise;
		harness.account.current = null;
		harness.account.generation += 1;
		let cleanupSettled = false;
		const cleanup = harness.coordinator
			.cancelAllForAccount("account-a")
			.then(() => {
				cleanupSettled = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cleanupSettled).toBe(false);

		releaseRead.resolve();
		await expect(starting).resolves.toEqual(
			expect.objectContaining({ kind: "unavailable" }),
		);
		await cleanup;
		expect(cleanupSettled).toBe(true);
		expect(
			harness.sidecar.calls.filter(
				(call) => call.method === "conversation.start",
			),
		).toHaveLength(0);
		await expect(
			harness.repository.listRuns("account-a", 100),
		).resolves.toEqual([]);
	});

	test("keeps reverse host calls bound to their owning session and drains them before logout", async () => {
		const harness = createHarness();
		const started = await harness.coordinator.startConversationTurn({
			requestId: "request-host-call-race",
			clientMessageId: "client-host-call-race",
			text: "验证反向调用绑定",
		});
		if (started.kind !== "success")
			throw new Error("conversation run was not accepted");
		const hostCallStarted = deferred();
		const releaseHostCall = deferred();
		const observedAccounts: string[] = [];
		const hostCall = harness.coordinator.runBoundHostCall(
			started.data.runId,
			async (accountId) => {
				observedAccounts.push(accountId);
				hostCallStarted.resolve();
				await releaseHostCall.promise;
				return accountId;
			},
		);
		await hostCallStarted.promise;

		harness.account.current = "account-b";
		harness.account.generation += 1;
		let cleanupSettled = false;
		const cleanup = harness.coordinator
			.cancelAllForAccount("account-a")
			.then(() => {
				cleanupSettled = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cleanupSettled).toBe(false);
		expect(observedAccounts).toEqual(["account-a"]);

		releaseHostCall.resolve();
		await expect(hostCall).rejects.toThrow("登录会话");
		await cleanup;
		expect(cleanupSettled).toBe(true);
		await expect(
			harness.coordinator.runBoundHostCall(
				started.data.runId,
				async () => "late",
			),
		).rejects.toThrow("登录会话");
		await expect(
			harness.repository.getRun("account-a", started.data.runId),
		).resolves.toEqual(expect.objectContaining({ status: "cancelled" }));
		await expect(
			harness.coordinator.getAgentRunSnapshot(started.data.runId),
		).resolves.toEqual(expect.objectContaining({ kind: "not-found" }));
	});

	test("rejects conversation memory access outside the owning run's thread", async () => {
		const harness = createHarness();
		const first = await harness.coordinator.startConversationTurn({
			requestId: "request-memory-owner-a",
			clientMessageId: "client-memory-owner-a",
			text: "第一段私有对话",
		});
		const second = await harness.coordinator.startConversationTurn({
			requestId: "request-memory-owner-b",
			clientMessageId: "client-memory-owner-b",
			text: "第二段私有对话",
		});
		if (first.kind !== "success" || second.kind !== "success") {
			throw new Error("conversation runs were not accepted");
		}
		const secondStart = harness.sidecar.calls.find(
			(call) =>
				call.method === "conversation.start" &&
				call.params.runId === second.data.runId,
		);
		const secondConversationId = String(secondStart?.params.conversationId);

		await expect(
			harness.coordinator.load(
				"account-a",
				first.data.runId,
				secondConversationId,
			),
		).rejects.toThrow("owning Agent run");
	});

	test("does not resurrect an old run when the same account gets a new session generation", async () => {
		const harness = createHarness();
		const started = await harness.coordinator.startConversationTurn({
			requestId: "request-generation-owner",
			clientMessageId: "client-generation-owner",
			text: "旧会话运行",
		});
		if (started.kind !== "success")
			throw new Error("conversation run was not accepted");
		harness.account.generation += 1;
		harness.coordinator.acceptSidecarEvent(
			runEvent(
				started.data.runId,
				1,
				{ kind: "run.completed", result: { text: "迟到回答" } },
				"completed",
			),
		);

		await expect(
			harness.coordinator.runBoundHostCall(
				started.data.runId,
				async () => "late",
			),
		).rejects.toThrow("登录会话");
		const restorable = await harness.coordinator.listRestorableAgentRuns({});
		expect(restorable).toEqual({
			kind: "success",
			data: {
				runs: [
					expect.objectContaining({
						runId: started.data.runId,
						status: "interrupted",
					}),
				],
			},
		});
		await expect(
			harness.repository.getRun("account-a", started.data.runId),
		).resolves.toEqual(expect.objectContaining({ status: "interrupted" }));
		expect(JSON.stringify(harness.events)).not.toContain("迟到回答");
	});

	test("drains an in-flight Sidecar event before logout and suppresses its late completion event", async () => {
		const harness = createHarness();
		const started = await harness.coordinator.startConversationTurn({
			requestId: "request-event-chain-race",
			clientMessageId: "client-event-chain-race",
			text: "等待完成事件",
		});
		if (started.kind !== "success")
			throw new Error("conversation run was not accepted");
		const completionWriteStarted = deferred();
		const releaseCompletionWrite = deferred();
		const originalPutMessage = harness.repository.putMessage.bind(
			harness.repository,
		);
		harness.repository.putMessage = async (record) => {
			if (
				record.runId === started.data.runId &&
				record.status === "complete" &&
				record.role === "assistant"
			) {
				completionWriteStarted.resolve();
				await releaseCompletionWrite.promise;
			}
			return originalPutMessage(record);
		};
		harness.coordinator.acceptSidecarEvent(
			runEvent(
				started.data.runId,
				1,
				{ kind: "run.completed", result: { text: "迟到完成内容" } },
				"completed",
			),
		);
		await completionWriteStarted.promise;

		harness.account.current = null;
		harness.account.generation += 1;
		let cleanupSettled = false;
		const cleanup = harness.coordinator
			.cancelAllForAccount("account-a")
			.then(() => {
				cleanupSettled = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cleanupSettled).toBe(false);

		releaseCompletionWrite.resolve();
		await cleanup;
		expect(cleanupSettled).toBe(true);
		expect(JSON.stringify(harness.events)).not.toContain(
			"conversation.message.completed",
		);
		await expect(
			harness.repository.getRun("account-a", started.data.runId),
		).resolves.toEqual(expect.objectContaining({ status: "cancelled" }));
	});

	test("deduplicates a client message and retries a failed run without writing the user message twice", async () => {
		const harness = createHarness();
		const input = {
			requestId: "request-original",
			clientMessageId: "client-message-1",
			text: "请帮我安排本周任务",
		};
		const first = await harness.coordinator.startConversationTurn(input);
		expect(first.kind).toBe("success");
		if (first.kind !== "success")
			throw new Error("initial run was not accepted");

		const duplicate = await harness.coordinator.startConversationTurn(input);
		expect(duplicate).toEqual({
			kind: "success",
			data: expect.objectContaining({ runId: first.data.runId }),
		});
		expect(
			harness.sidecar.calls.filter(
				(call) => call.method === "conversation.start",
			),
		).toHaveLength(1);

		harness.coordinator.acceptSidecarEvent(
			runEvent(first.data.runId, 1, {
				kind: "run.failed",
				error: {
					code: "MODEL_RELAY_ERROR",
					message: "上游连接中断",
					retryable: true,
				},
			}),
		);
		await waitFor(
			async () =>
				(await harness.repository.getRun("account-a", first.data.runId))
					?.status === "failed",
		);

		const retry = await harness.coordinator.startConversationTurn({
			...input,
			requestId: "request-retry",
			retryOfRunId: first.data.runId,
		});
		expect(retry.kind).toBe("success");
		if (retry.kind !== "success") throw new Error("retry run was not accepted");
		expect(retry.data.runId).not.toBe(first.data.runId);

		const conversation = (
			await harness.repository.listConversations("account-a")
		)[0]!;
		const messages = await harness.repository.listMessages(
			"account-a",
			conversation.id,
		);
		expect(messages.filter((message) => message.role === "user")).toHaveLength(
			1,
		);
		expect(
			messages.filter((message) => message.role === "assistant"),
		).toHaveLength(2);
		expect(
			messages.filter(
				(message) => message.clientMessageId === input.clientMessageId,
			),
		).toHaveLength(1);
		expect(
			harness.sidecar.calls.filter(
				(call) => call.method === "conversation.start",
			),
		).toHaveLength(2);
	});

	test("aborts the model relay directly by runId before delegating normal cancellation to Sidecar", async () => {
		const harness = createHarness();
		const started = await harness.coordinator.startConversationTurn({
			requestId: "request-direct-relay-abort",
			clientMessageId: "client-direct-relay-abort",
			text: "停止这个仍在等待模型响应头的运行",
		});
		if (started.kind !== "success")
			throw new Error("conversation run was not accepted");

		const cancelled = await harness.coordinator.cancelAgentRun({
			requestId: "request-direct-relay-cancel",
			runId: started.data.runId,
			expectedRevision: started.data.revision,
		});
		expect(cancelled.kind).toBe("success");
		expect(harness.relayAborts).toEqual([started.data.runId]);
		expect(harness.sidecar.calls).toContainEqual(
			expect.objectContaining({
				method: "run.cancel",
				params: { runId: started.data.runId, reason: "user" },
			}),
		);
	});

	test("persists relay capability unavailability as non-retryable instead of model retry", async () => {
		const harness = createHarness();
		const started = await harness.coordinator.startConversationTurn({
			requestId: "request-relay-unavailable",
			clientMessageId: "client-relay-unavailable",
			text: "尝试使用当前不可用的模型能力",
		});
		if (started.kind !== "success")
			throw new Error("conversation run was not accepted");
		harness.coordinator.acceptSidecarEvent(
			runEvent(
				started.data.runId,
				1,
				{
					kind: "run.failed",
					error: {
						code: "MODEL_RELAY_UNAVAILABLE",
						message: "当前测试账号没有模型转发能力。",
						retryable: false,
					},
				},
				"failed",
			),
		);
		await waitFor(
			async () =>
				(await harness.repository.getRun("account-a", started.data.runId))
					?.status === "failed",
		);
		const snapshot = await harness.coordinator.getAgentRunSnapshot(
			started.data.runId,
		);
		expect(snapshot).toEqual({
			kind: "success",
			data: expect.objectContaining({
				failure: {
					code: "unavailable",
					message: "当前测试账号没有模型转发能力。",
					retryable: false,
				},
			}),
		});
	});

	test("makes Bun's proposal revision authoritative and executes only the matching one-time approval", async () => {
		const harness = createHarness();
		const started = await harness.coordinator.startConversationTurn({
			requestId: "request-tool",
			clientMessageId: "client-tool",
			text: "请创建日程",
		});
		if (started.kind !== "success")
			throw new Error("tool run was not accepted");
		const argumentsValue = {
			event: {
				id: "event-tool-1",
				title: "深度工作",
				kind: "manual-block",
				state: "committed",
				schedule: {
					allDay: false,
					start: "2026-08-03T01:00:00.000Z",
					end: "2026-08-03T02:00:00.000Z",
					timeZone: "Asia/Shanghai",
				},
				recurrence: null,
				occurrenceId: null,
				sourcePlanId: null,
				editable: true,
				version: 0,
			},
		};

		const proposal = (await harness.coordinator.propose("account-a", {
			runId: started.data.runId,
			toolCallId: "tool-call-1",
			name: "calendar.create_event",
			arguments: argumentsValue,
			runVersion: 9_999,
		})) as {
			approvalId: string;
			inputDigest: string;
			description: string;
			runVersion: number;
		};
		expect(proposal.runVersion).toBe(2);
		expect(proposal.runVersion).not.toBe(9_999);
		expect(proposal.description).not.toContain(
			argumentsValue.event.schedule.start,
		);

		const decision = await harness.coordinator.decideAgentToolApproval({
			requestId: "request-approval",
			runId: started.data.runId,
			approvalId: proposal.approvalId,
			toolCallId: "tool-call-1",
			inputDigest: proposal.inputDigest,
			expectedRevision: proposal.runVersion,
			decision: "approve-once",
		});
		expect(decision).toEqual({
			kind: "success",
			data: expect.objectContaining({ revision: 3 }),
		});

		await expect(
			harness.coordinator.call("account-a", {
				runId: started.data.runId,
				toolCallId: "tool-call-1",
				name: "calendar.create_event",
				arguments: argumentsValue,
				approvalId: proposal.approvalId,
				inputDigest: proposal.inputDigest,
				runVersion: proposal.runVersion,
			}),
		).resolves.toEqual({ committed: true });
		expect(harness.executions).toEqual([
			expect.objectContaining({
				accountId: "account-a",
				runId: started.data.runId,
				toolCallId: "tool-call-1",
				name: "calendar.create_event",
				arguments: argumentsValue,
			}),
		]);
		await expect(
			harness.coordinator.call("account-a", {
				runId: started.data.runId,
				toolCallId: "tool-call-1",
				name: "calendar.create_event",
				arguments: argumentsValue,
				approvalId: proposal.approvalId,
				inputDigest: proposal.inputDigest,
				runVersion: proposal.runVersion,
			}),
		).rejects.toThrow("one-time approval binding");
		expect(JSON.stringify(harness.events)).not.toContain(
			argumentsValue.event.schedule.start,
		);
	});

	test("rechecks approval expiry immediately before execution and performs no late write", async () => {
		const harness = createHarness();
		const started = await harness.coordinator.startConversationTurn({
			requestId: "request-expiring-tool",
			clientMessageId: "client-expiring-tool",
			text: "请创建一个稍后审批的日程",
		});
		if (started.kind !== "success")
			throw new Error("tool run was not accepted");
		const argumentsValue = calendarCreateArguments("event-expired-approval");
		const proposal = (await harness.coordinator.propose("account-a", {
			runId: started.data.runId,
			toolCallId: "tool-call-expired",
			name: "calendar.create_event",
			arguments: argumentsValue,
		})) as {
			approvalId: string;
			inputDigest: string;
			runVersion: number;
		};
		const decision = await harness.coordinator.decideAgentToolApproval({
			requestId: "request-expiring-tool-approve",
			runId: started.data.runId,
			approvalId: proposal.approvalId,
			toolCallId: "tool-call-expired",
			inputDigest: proposal.inputDigest,
			expectedRevision: proposal.runVersion,
			decision: "approve-once",
		});
		expect(decision.kind).toBe("success");
		harness.advanceClock(10 * 60 * 1_000 + 1);

		await expect(
			harness.coordinator.call("account-a", {
				runId: started.data.runId,
				toolCallId: "tool-call-expired",
				name: "calendar.create_event",
				arguments: argumentsValue,
				approvalId: proposal.approvalId,
				inputDigest: proposal.inputDigest,
				runVersion: proposal.runVersion,
			}),
		).rejects.toThrow();
		expect(harness.executions).toHaveLength(0);
	});

	test("rebuilds a persisted suspended approval and makes one non-replayed write attempt after approval", async () => {
		const approvedHarness = createHarness();
		const approvedPending = await persistSuspendedCalendarApproval(
			approvedHarness,
			"approved",
		);
		const approvedCoordinator = restartCoordinator(approvedHarness);

		const approved = await approvedCoordinator.decideAgentToolApproval({
			requestId: "request-recovered-approve",
			runId: approvedPending.runId,
			approvalId: approvedPending.approval.approvalId,
			toolCallId: approvedPending.toolCallId,
			inputDigest: approvedPending.approval.inputDigest,
			expectedRevision: approvedPending.approval.runVersion,
			decision: "approve-once",
		});
		expect(approved.kind).toBe("success");
		await waitFor(async () => {
			const record = await approvedHarness.repository.getRun(
				"account-a",
				approvedPending.runId,
			);
			return (
				approvedHarness.executions.length === 1 &&
				record?.status === "completed"
			);
		});
		expect(approvedHarness.executions).toEqual([
			expect.objectContaining({
				runId: approvedPending.runId,
				toolCallId: approvedPending.toolCallId,
				name: "calendar.create_event",
				arguments: approvedPending.argumentsValue,
			}),
		]);

		const duplicate = await approvedCoordinator.decideAgentToolApproval({
			requestId: "request-recovered-approve-again",
			runId: approvedPending.runId,
			approvalId: approvedPending.approval.approvalId,
			toolCallId: approvedPending.toolCallId,
			inputDigest: approvedPending.approval.inputDigest,
			expectedRevision: approvedPending.approval.runVersion,
			decision: "approve-once",
		});
		expect(duplicate.kind).not.toBe("success");
		expect(approvedHarness.executions).toHaveLength(1);

		const deniedHarness = createHarness();
		const deniedPending = await persistSuspendedCalendarApproval(
			deniedHarness,
			"denied",
		);
		const deniedCoordinator = restartCoordinator(deniedHarness);
		const denied = await deniedCoordinator.decideAgentToolApproval({
			requestId: "request-recovered-deny",
			runId: deniedPending.runId,
			approvalId: deniedPending.approval.approvalId,
			toolCallId: deniedPending.toolCallId,
			inputDigest: deniedPending.approval.inputDigest,
			expectedRevision: deniedPending.approval.runVersion,
			decision: "deny",
		});
		expect(denied.kind).toBe("success");
		await waitFor(
			async () =>
				(
					await deniedHarness.repository.getRun(
						"account-a",
						deniedPending.runId,
					)
				)?.status === "completed",
		);
		expect(deniedHarness.executions).toHaveLength(0);
	});

	test("keeps a recovered approved Tool non-cancellable until its local execution settles", async () => {
		const harness = createHarness();
		const pending = await persistSuspendedCalendarApproval(harness, "critical");
		const sidecar = new RecordingSidecar();
		const executionStarted = deferred();
		const releaseExecution = deferred();
		const coordinator = new AgentRunCoordinator({
			sessionIdentity: () => sessionIdentity(harness.account),
			repository: harness.repository,
			sidecar,
			abortModelRelay: (runId) => {
				harness.relayAborts.push(runId);
				return true;
			},
			toolPolicy: new AgentToolPolicy(harness.repository, harness.clock),
			toolExecutor: {
				execute: async (input) => {
					harness.executions.push(structuredClone(input));
					executionStarted.resolve();
					await releaseExecution.promise;
					return { committed: true };
				},
			},
			onEvent: (event) => harness.events.push(structuredClone(event)),
			now: harness.clock,
		});

		const approved = await coordinator.decideAgentToolApproval({
			requestId: "request-critical-approve",
			runId: pending.runId,
			approvalId: pending.approval.approvalId,
			toolCallId: pending.toolCallId,
			inputDigest: pending.approval.inputDigest,
			expectedRevision: pending.approval.runVersion,
			decision: "approve-once",
		});
		if (approved.kind !== "success")
			throw new Error("recovered approval was not accepted");
		await executionStarted.promise;

		await expect(
			coordinator.cancelAgentRun({
				requestId: "request-critical-cancel",
				runId: pending.runId,
				expectedRevision: approved.data.revision,
			}),
		).resolves.toEqual(expect.objectContaining({ kind: "conflict" }));

		let logoutSettled = false;
		let interruptSettled = false;
		const logout = coordinator.cancelAllForAccount("account-a").then(() => {
			logoutSettled = true;
		});
		const interrupted = coordinator
			.interruptRuns(
				[pending.runId],
				"Sidecar exited during recovered Tool execution.",
			)
			.then(() => {
				interruptSettled = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(logoutSettled).toBe(false);
		expect(interruptSettled).toBe(false);
		expect(
			sidecar.calls.filter((call) => call.method === "run.cancel"),
		).toHaveLength(0);

		releaseExecution.resolve();
		await Promise.all([logout, interrupted]);
		await waitFor(
			async () =>
				(await harness.repository.getRun("account-a", pending.runId))
					?.status === "completed",
		);
		expect(harness.executions).toHaveLength(1);
		expect(
			sidecar.calls.filter((call) => call.method === "run.cancel"),
		).toHaveLength(0);
	});

	test("persists a second-pass planning conflict with the complete draft and performs no write", async () => {
		const harness = createHarness();
		await harness.repository.ensureAccount("account-a");
		await harness.repository.setGrant("account-a", "agent.calendar.read");
		await harness.repository.setGrant("account-a", "agent.planning.read");
		const started = await harness.coordinator.startTaskPlanningRun({
			requestId: "request-planning",
			input: planningInput(),
		});
		if (started.kind !== "success")
			throw new Error("planning run was not accepted");
		const sidecarStart = harness.sidecar.calls.find(
			(call) => call.method === "planning.start",
		);
		const sessionId = String(sidecarStart?.params.sessionId);
		const draft = planningDraft();
		const result = {
			sessionId,
			status: "conflict",
			draft,
			validationIssues: [
				{
					code: "calendar-conflict",
					message: "最新日历仍与提案冲突",
					proposalId: "schedule-1",
					busyEventIds: ["busy-event-1"],
				},
			],
			version: 2,
		};
		harness.coordinator.acceptSidecarEvent(
			runEvent(
				started.data.runId,
				1,
				{ kind: "run.completed", result },
				"completed",
			),
		);
		await waitFor(
			async () =>
				(await harness.repository.getRun("account-a", started.data.runId))
					?.status === "completed",
		);

		const restarted = new AgentRunCoordinator({
			sessionIdentity: () => ({
				accountId: "account-a",
				sessionId: "session-account-a-1",
				generation: 1,
			}),
			repository: harness.repository,
			sidecar: new RecordingSidecar(),
			abortModelRelay: () => false,
			toolPolicy: new AgentToolPolicy(harness.repository, harness.clock),
			toolExecutor: { execute: async () => ({ committed: true }) },
			onEvent() {},
			now: harness.clock,
		});
		const restored = await restarted.getAgentRunSnapshot(started.data.runId);
		expect(restored.kind).toBe("success");
		if (restored.kind !== "success" || restored.data.kind !== "task-planning") {
			throw new Error("planning snapshot was not restored");
		}
		expect(restored.data.status).toBe("completed");
		expect(restored.data.session).toEqual({
			id: sessionId,
			status: "conflict",
			draft,
			validationIssues: result.validationIssues,
		});
		expect(
			restored.data.session?.status === "conflict" &&
				restored.data.session.draft.schedule,
		).toEqual(draft.schedule);
		expect(harness.executions).toHaveLength(0);
		await expect(
			harness.repository.listCalendarEvents("account-a"),
		).resolves.toEqual([]);
	});

	test("resumes a persisted planning run with its original durable request identity", async () => {
		const harness = createHarness();
		await harness.repository.ensureAccount("account-a");
		await harness.repository.setGrant("account-a", "agent.calendar.read");
		await harness.repository.setGrant("account-a", "agent.planning.read");
		const originatingRequestId = "request-planning-durable-origin";
		const started = await harness.coordinator.startTaskPlanningRun({
			requestId: originatingRequestId,
			input: planningInput(),
		});
		if (started.kind !== "success") {
			throw new Error("planning run was not accepted");
		}
		const sidecarStart = harness.sidecar.calls.find(
			(call) => call.method === "planning.start",
		);
		const sessionId = String(sidecarStart?.params.sessionId);
		harness.coordinator.acceptSidecarEvent(
			runEvent(
				started.data.runId,
				1,
				{
					kind: "run.suspended",
					suspendPayload: {
						kind: "planning.clarification",
						sessionId,
						status: "clarifying",
						clarificationRounds: 1,
						version: 1,
						questions: [
							{
								key: "expected_outcome",
								text: "需要怎样的验收结果？",
								required: true,
							},
						],
					},
				},
				null,
			),
		);
		await waitFor(
			async () =>
				(await harness.repository.getRun("account-a", started.data.runId))
					?.status === "suspended",
		);

		const restartedSidecar = new RecordingSidecar();
		const restarted = restartCoordinator(harness, restartedSidecar);
		const continued = await restarted.submitPlanningClarification({
			requestId: "request-clarification-command-random",
			runId: started.data.runId,
			expectedRevision: 2,
			answers: [
				{ questionKey: "expected_outcome", answerText: "安装并通过核心验收" },
			],
		});

		expect(continued.kind).toBe("success");
		expect(restartedSidecar.calls).toContainEqual(
			expect.objectContaining({
				method: "planning.answer",
				params: expect.objectContaining({
					runId: started.data.runId,
					sessionId,
					originatingRequestId,
				}),
				options: expect.objectContaining({
					requestId: "request-clarification-command-random",
				}),
			}),
		);
	});
});

class RecordingSidecar implements AgentSidecar {
	readonly calls: Array<{
		method: AgentHostMethod;
		params: Record<string, unknown>;
		options?: { requestId?: string; timeoutMs?: number };
	}> = [];
	readonly tracked = new Set<string>();

	request<TResult = unknown>(
		method: AgentHostMethod,
		params: Record<string, unknown>,
		options?: { requestId?: string; timeoutMs?: number },
	): Promise<TResult> {
		this.calls.push({ method, params: structuredClone(params), options });
		return Promise.resolve({ accepted: true } as TResult);
	}

	trackRun(runId: string): void {
		this.tracked.add(runId);
	}

	untrackRun(runId: string): void {
		this.tracked.delete(runId);
	}
}

class MemoryKeyStore implements CredentialKeyStore {
	private readonly keys = new Map<string, Uint8Array>();
	private counter = 0;

	async getKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const value = this.keys.get(referenceKey(reference));
		if (!value) throw new CredentialHelperError("NOT_FOUND");
		return value.slice();
	}

	async createKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const id = referenceKey(reference);
		if (this.keys.has(id)) throw new CredentialHelperError("ALREADY_EXISTS");
		this.counter += 1;
		const value = Uint8Array.from(
			{ length: 32 },
			(_, index) => (this.counter * 31 + index * 17) & 0xff,
		);
		this.keys.set(id, value);
		return value.slice();
	}

	async deleteKey(
		reference: CredentialKeyReference,
	): Promise<{ deleted: boolean }> {
		return { deleted: this.keys.delete(referenceKey(reference)) };
	}
}

function createHarness(): {
	account: { current: string | null; generation: number };
	repository: EncryptedAgentRepository;
	sidecar: RecordingSidecar;
	coordinator: AgentRunCoordinator;
	events: InternalAgentRunEventEnvelope[];
	activityTerminals: Array<Record<string, unknown>>;
	executions: Record<string, unknown>[];
	relayAborts: string[];
	clock: () => number;
	advanceClock(milliseconds: number): void;
} {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-agent-coordinator-"));
	temporaryDirectories.push(directory);
	let now = 1_000_000;
	const clock = () => now++;
	const advanceClock = (milliseconds: number): void => {
		now += milliseconds;
	};
	const repository = new EncryptedAgentRepository({
		databasePath: join(directory, "agent.sqlite3"),
		installationId: "installation-test",
		keyStore: new MemoryKeyStore(),
		now: clock,
	});
	openRepositories.push(repository);
	const account = { current: "account-a" as string | null, generation: 1 };
	const sidecar = new RecordingSidecar();
	const events: InternalAgentRunEventEnvelope[] = [];
	const activityTerminals: Array<Record<string, unknown>> = [];
	const executions: Record<string, unknown>[] = [];
	const relayAborts: string[] = [];
	const coordinator = new AgentRunCoordinator({
		sessionIdentity: () => sessionIdentity(account),
		repository,
		sidecar,
		abortModelRelay: (runId) => {
			relayAborts.push(runId);
			return true;
		},
		toolPolicy: new AgentToolPolicy(repository, clock),
		toolExecutor: {
			execute: async (input) => {
				executions.push(structuredClone(input));
				return { committed: true };
			},
		},
		onEvent: (event) => events.push(structuredClone(event)),
		onActivityRunTerminal: (input) => {
			activityTerminals.push(structuredClone(input));
		},
		now: clock,
	});
	return {
		account,
		repository,
		sidecar,
		coordinator,
		events,
		activityTerminals,
		executions,
		relayAborts,
		clock,
		advanceClock,
	};
}

type CoordinatorHarness = ReturnType<typeof createHarness>;

function sessionIdentity(account: {
	current: string | null;
	generation: number;
}) {
	return account.current
		? {
				accountId: account.current,
				sessionId: `session-${account.current}-${account.generation}`,
				generation: account.generation,
			}
		: null;
}

function restartCoordinator(
	harness: CoordinatorHarness,
	sidecar: RecordingSidecar = new RecordingSidecar(),
): AgentRunCoordinator {
	return new AgentRunCoordinator({
		sessionIdentity: () => sessionIdentity(harness.account),
		repository: harness.repository,
		sidecar,
		abortModelRelay: (runId) => {
			harness.relayAborts.push(runId);
			return true;
		},
		toolPolicy: new AgentToolPolicy(harness.repository, harness.clock),
		toolExecutor: {
			execute: async (input) => {
				harness.executions.push(structuredClone(input));
				return { committed: true };
			},
		},
		onEvent: (event) => harness.events.push(structuredClone(event)),
		onActivityRunTerminal: (input) => {
			harness.activityTerminals.push(structuredClone(input));
		},
		now: harness.clock,
	});
}

async function persistSuspendedCalendarApproval(
	harness: CoordinatorHarness,
	suffix: string,
): Promise<{
	runId: string;
	toolCallId: string;
	argumentsValue: ReturnType<typeof calendarCreateArguments>;
	approval: {
		approvalId: string;
		inputDigest: string;
		runVersion: number;
	};
}> {
	const started = await harness.coordinator.startConversationTurn({
		requestId: `request-${suffix}`,
		clientMessageId: `client-${suffix}`,
		text: "请创建日程",
	});
	if (started.kind !== "success") throw new Error("tool run was not accepted");
	const toolCallId = `tool-call-${suffix}`;
	const argumentsValue = calendarCreateArguments(`event-${suffix}`);
	const approval = (await harness.coordinator.propose("account-a", {
		runId: started.data.runId,
		toolCallId,
		name: "calendar.create_event",
		arguments: argumentsValue,
	})) as {
		approvalId: string;
		inputDigest: string;
		runVersion: number;
	};
	harness.coordinator.acceptSidecarEvent(
		runEvent(
			started.data.runId,
			1,
			{
				kind: "run.suspended",
				suspendPayload: { approvalId: approval.approvalId },
			},
			null,
		),
	);
	await waitFor(
		async () =>
			(await harness.repository.getRun("account-a", started.data.runId))
				?.status === "suspended",
	);
	return { runId: started.data.runId, toolCallId, argumentsValue, approval };
}

function calendarCreateArguments(eventId: string) {
	return {
		event: {
			id: eventId,
			title: "深度工作",
			kind: "manual-block",
			state: "committed",
			schedule: {
				allDay: false,
				start: "2026-08-03T01:00:00.000Z",
				end: "2026-08-03T02:00:00.000Z",
				timeZone: "Asia/Shanghai",
			},
			recurrence: null,
			occurrenceId: null,
			sourcePlanId: null,
			editable: true,
			version: 0,
		},
	};
}

function referenceKey(reference: CredentialKeyReference): string {
	return `${reference.installationId}:${reference.accountId}:v${reference.keyVersion}`;
}

function runEvent(
	runId: string,
	sequence: number,
	event: AgentRunEventFrame["event"],
	terminalState: AgentRunEventFrame["terminalState"] = "failed",
): AgentRunEventFrame {
	return {
		protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
		type: "event",
		requestId: `sidecar-${sequence}`,
		runId,
		sequence,
		version: sequence,
		emittedAtMs: 2_000_000 + sequence,
		terminalState,
		event,
	};
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline)
			throw new Error("Timed out waiting for asynchronous coordinator state.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function planningInput(): TaskPlanningInput {
	return {
		goal: "完成本地 Agent 重构",
		planType: "short-term",
		deadline: "2026-08-31",
		priority: "high",
		weeklyCapacityHours: 20,
		unavailableDays: [],
		preferredSessionMinutes: 60,
		preferredDayPart: "morning",
		timeZone: "Asia/Shanghai",
	};
}

function planningDraft(): TaskPlanningDraft {
	return {
		id: "draft-1",
		title: "本地 Agent 重构计划",
		assumptions: ["远端只转发模型请求"],
		calendarRevision: 7,
		phases: [
			{
				id: "phase-1",
				title: "本地运行",
				objective: "完成本地 Agent 链路",
				order: 1,
			},
		],
		milestones: [
			{
				id: "milestone-1",
				phaseId: "phase-1",
				title: "完成 Sidecar",
				description: "打通本地运行链路",
				targetDate: "2026-08-10",
				acceptanceCriteria: ["本地运行通过"],
			},
		],
		tasks: [
			{
				id: "task-1",
				milestoneId: "milestone-1",
				title: "验证规划冲突",
				description: "保留冲突草案",
				estimatedMinutes: 60,
				importance: "high",
				dependencies: [],
				completionCriteria: ["冲突不自动提交"],
			},
		],
		schedule: [
			{
				id: "schedule-1",
				taskId: "task-1",
				title: "验证规划冲突",
				start: "2026-08-03T01:00:00.000Z",
				end: "2026-08-03T02:00:00.000Z",
				timeZone: "Asia/Shanghai",
			},
		],
		unscheduledTaskIds: [],
	};
}
