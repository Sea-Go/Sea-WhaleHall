import { describe, expect, test } from "bun:test";
import {
	AgentToolPolicy,
	digestArguments,
	type AgentPermission,
	type PendingToolApproval,
	type ToolApprovalRepository,
} from "../src/bun/agent-tool-policy";

class MemoryPolicyRepository implements ToolApprovalRepository {
	readonly grants = new Set<string>();
	readonly approvals = new Map<string, PendingToolApproval>();
	async hasGrant(accountId: string, permission: AgentPermission): Promise<boolean> {
		return this.grants.has(`${accountId}:${permission}`);
	}
	async putApproval(approval: PendingToolApproval): Promise<void> {
		this.approvals.set(approval.approvalId, structuredClone(approval));
	}
	async getApproval(accountId: string, approvalId: string): Promise<PendingToolApproval | null> {
		const approval = this.approvals.get(approvalId);
		return approval?.accountId === accountId ? structuredClone(approval) : null;
	}
	async compareAndSetApprovalStatus(
		accountId: string,
		approvalId: string,
		expected: PendingToolApproval["status"],
		next: PendingToolApproval["status"],
	): Promise<boolean> {
		const approval = this.approvals.get(approvalId);
		if (!approval || approval.accountId !== accountId || approval.status !== expected) return false;
		this.approvals.set(approvalId, { ...approval, status: next });
		return true;
	}
}

describe("AgentToolPolicy", () => {
	test("presents save-draft creation and versioned update as different approvals", async () => {
		const repository = new MemoryPolicyRepository();
		const policy = new AgentToolPolicy(repository, () => 5_000);
		const created = await policy.proposeWrite({
			accountId: "account-a",
			runId: "run-create",
			toolCallId: "tool-create",
			toolName: "planning.save_draft",
			arguments: { draft: { title: "季度计划" } },
			runRevision: 1,
		});
		expect(created.title).toBe("新建计划草案");
		expect(created.description).toContain("草案标识由 WhaleHall 生成");

		const updated = await policy.proposeWrite({
			accountId: "account-a",
			runId: "run-update",
			toolCallId: "tool-update",
			toolName: "planning.save_draft",
			arguments: {
				expectedVersion: 7,
				draft: { id: "draft-1", title: "季度计划" },
			},
			runRevision: 2,
		});
		expect(updated.title).toBe("更新计划草案");
		expect(updated.description).toContain("预期版本 7");
	});

	test("requires an id and valid expectedVersion only for save-draft updates", async () => {
		const repository = new MemoryPolicyRepository();
		const policy = new AgentToolPolicy(repository);
		await expect(policy.proposeWrite({
			accountId: "account-a",
			runId: "run-1",
			toolCallId: "tool-1",
			toolName: "planning.save_draft",
			arguments: { expectedVersion: 3, draft: { title: "缺少标识" } },
			runRevision: 1,
		})).rejects.toEqual(expect.objectContaining({ code: "approval-mismatch" }));
		await expect(policy.proposeWrite({
			accountId: "account-a",
			runId: "run-1",
			toolCallId: "tool-2",
			toolName: "planning.save_draft",
			arguments: { expectedVersion: -1, draft: { id: "draft-1", title: "错误版本" } },
			runRevision: 1,
		})).rejects.toEqual(expect.objectContaining({ code: "approval-mismatch" }));
	});

	test("only permits allowlisted reads with an account grant", async () => {
		const repository = new MemoryPolicyRepository();
		const policy = new AgentToolPolicy(repository);
		await expect(policy.assertReadAllowed("a", "calendar.list_events")).rejects.toEqual(
			expect.objectContaining({ code: "permission-required" }),
		);
		repository.grants.add("a:agent.calendar.read");
		await expect(policy.assertReadAllowed("a", "calendar.list_events")).resolves.toBe("calendar.list_events");
		await expect(policy.assertReadAllowed("a", "browser.history")).rejects.toEqual(
			expect.objectContaining({ code: "tool-not-allowed" }),
		);
	});

	test("binds one-time approval to run, tool, digest and revision", async () => {
		const repository = new MemoryPolicyRepository();
		let now = 1_000;
		const policy = new AgentToolPolicy(repository, () => now);
		const args = {
			title: "伪造标题",
			event: { id: "event-1", title: "专注时间", start: "2026-08-01T01:00:00Z" },
		};
		const proposal = await policy.proposeWrite({
			accountId: "account-a",
			runId: "run-1",
			toolCallId: "tool-1",
			toolName: "calendar.create_event",
			arguments: args,
			runRevision: 3,
		});
		expect(proposal.description).toContain("专注时间");
		expect(proposal.description).not.toContain("伪造标题");
		expect(proposal.description).not.toContain("2026-08-01T01:00:00Z");
		await expect(policy.decide({
			accountId: "account-a",
			approvalId: proposal.approvalId,
			runId: "run-1",
			toolCallId: "tool-1",
			inputDigest: digestArguments(args),
			runRevision: 4,
			decision: "approve-once",
		})).rejects.toEqual(expect.objectContaining({ code: "approval-mismatch" }));

		await expect(policy.decide({
			accountId: "account-a",
			approvalId: proposal.approvalId,
			runId: "run-1",
			toolCallId: "tool-1",
			inputDigest: proposal.inputDigest,
			runRevision: 3,
			decision: "approve-once",
		})).resolves.toEqual(expect.objectContaining({ status: "approved" }));
		await expect(policy.decide({
			accountId: "account-a",
			approvalId: proposal.approvalId,
			runId: "run-1",
			toolCallId: "tool-1",
			inputDigest: proposal.inputDigest,
			runRevision: 3,
			decision: "approve-once",
		})).rejects.toEqual(expect.objectContaining({ code: "approval-consumed" }));
		now += 10 * 60_000;
	});

	test("presents cleaned event and plan schedule times without exposing raw arguments", async () => {
		const repository = new MemoryPolicyRepository();
		const policy = new AgentToolPolicy(repository, () => 1_000);
		const event = await policy.proposeWrite({
			accountId: "account-a",
			runId: "run-time",
			toolCallId: "tool-time",
			toolName: "calendar.create_event",
			arguments: {
				event: {
					id: "event-time",
					title: "深度工作\n注入内容",
					schedule: {
						allDay: false,
						start: "2026-08-01T09:30:00+08:00",
						end: "2026-08-01T10:30:00+08:00",
						timeZone: "Asia/Shanghai",
					},
				},
				providerKey: "must-not-be-presented",
			},
			runRevision: 1,
		});
		expect(event.description).toContain("深度工作 注入内容");
		expect(event.description).toContain("2026-08-01 09:30 至 2026-08-01 10:30");
		expect(event.description).toContain("Asia/Shanghai");
		expect(event.description).not.toContain("must-not-be-presented");

		const schedule = await policy.proposeWrite({
			accountId: "account-a",
			runId: "run-plan",
			toolCallId: "tool-plan",
			toolName: "calendar.commit_plan_schedule",
			arguments: {
				planId: "plan-1",
				calendarRevision: 2,
				schedule: [{
					id: "schedule-1",
					taskId: "task-1",
					title: "第一项",
					start: "2026-08-02T14:00:00+08:00",
					end: "2026-08-02T15:00:00+08:00",
					timeZone: "Asia/Shanghai",
				}],
			},
			runRevision: 2,
		});
		expect(schedule.description).toContain("1 项排程");
		expect(schedule.description).toContain("首项时间 2026-08-02 14:00");
	});

	test("expires an approved write when execution starts after the ten-minute deadline", async () => {
		const repository = new MemoryPolicyRepository();
		let now = 20_000;
		const policy = new AgentToolPolicy(repository, () => now);
		const proposal = await policy.proposeWrite({
			accountId: "account-a",
			runId: "run-late",
			toolCallId: "tool-late",
			toolName: "calendar.create_event",
			arguments: { event: { id: "event-late", title: "迟到的日程" } },
			runRevision: 9,
		});
		const approved = await policy.decide({
			accountId: "account-a",
			approvalId: proposal.approvalId,
			runId: "run-late",
			toolCallId: "tool-late",
			inputDigest: proposal.inputDigest,
			runRevision: 9,
			decision: "approve-once",
		});

		now = proposal.expiresAtMs - 1;
		await expect(policy.assertApprovedForExecution(approved)).resolves.toEqual(
			expect.objectContaining({ status: "approved" }),
		);
		now = proposal.expiresAtMs;
		await expect(policy.assertApprovedForExecution(approved)).rejects.toEqual(
			expect.objectContaining({ code: "approval-expired" }),
		);
		expect(repository.approvals.get(proposal.approvalId)?.status).toBe("expired");
		await expect(policy.assertApprovedForExecution(approved)).rejects.toEqual(
			expect.objectContaining({ code: "approval-consumed" }),
		);
	});

	test("rejects an update whose displayed event id differs from the executed event", async () => {
		const repository = new MemoryPolicyRepository();
		const policy = new AgentToolPolicy(repository);
		await expect(policy.proposeWrite({
			accountId: "account-a",
			runId: "run-1",
			toolCallId: "tool-1",
			toolName: "calendar.update_event",
			arguments: {
				eventId: "visible-event",
				expectedVersion: 1,
				event: { id: "different-event", title: "实际被修改的事件" },
			},
			runRevision: 1,
		})).rejects.toEqual(expect.objectContaining({ code: "approval-mismatch" }));
	});

	test("revalidates persisted Tool metadata, arguments and digest before consuming approval", async () => {
		const repository = new MemoryPolicyRepository();
		const policy = new AgentToolPolicy(repository, () => 1_000);
		const argumentsValue = { event: { id: "event-1", title: "原始日程" } };
		const changedArguments = await policy.proposeWrite({
			accountId: "account-a",
			runId: "run-1",
			toolCallId: "tool-1",
			toolName: "calendar.create_event",
			arguments: argumentsValue,
			runRevision: 1,
		});
		const changedRecord = repository.approvals.get(changedArguments.approvalId)!;
		repository.approvals.set(changedArguments.approvalId, {
			...changedRecord,
			arguments: { event: { id: "event-2", title: "被替换的日程" } },
		});
		await expect(policy.decide({
			accountId: "account-a",
			approvalId: changedArguments.approvalId,
			runId: "run-1",
			toolCallId: "tool-1",
			inputDigest: changedArguments.inputDigest,
			runRevision: 1,
			decision: "approve-once",
		})).rejects.toEqual(expect.objectContaining({ code: "approval-mismatch" }));
		expect(repository.approvals.get(changedArguments.approvalId)?.status).toBe("pending");

		const changedTool = await policy.proposeWrite({
			accountId: "account-a",
			runId: "run-2",
			toolCallId: "tool-2",
			toolName: "calendar.create_event",
			arguments: argumentsValue,
			runRevision: 2,
		});
		const changedToolRecord = repository.approvals.get(changedTool.approvalId)!;
		repository.approvals.set(changedTool.approvalId, {
			...changedToolRecord,
			toolName: "browser.history" as PendingToolApproval["toolName"],
		});
		await expect(policy.decide({
			accountId: "account-a",
			approvalId: changedTool.approvalId,
			runId: "run-2",
			toolCallId: "tool-2",
			inputDigest: changedTool.inputDigest,
			runRevision: 2,
			decision: "approve-once",
		})).rejects.toEqual(expect.objectContaining({ code: "approval-mismatch" }));
		expect(repository.approvals.get(changedTool.approvalId)?.status).toBe("pending");
	});
});
