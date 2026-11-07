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






});
