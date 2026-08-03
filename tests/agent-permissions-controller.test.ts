import { describe, expect, test } from "bun:test";
import {
	AGENT_READ_PERMISSION_IDS,
	hasAllAgentReadPermissions,
} from "../src/shared/agent-permissions";
import { AgentPermissionsController } from "../src/views/client/features/settings/AgentPermissionsController";
import { ElectrobunAgentPermissionsService } from "../src/views/client/infrastructure/settings/ElectrobunAgentPermissionsService";
import { MockAgentPermissionsService } from "../src/views/client/infrastructure/settings/MockAgentPermissionsService";

describe("AgentPermissionsController", () => {
	test("loads with both sensitive read grants disabled by default", async () => {
		const controller = new AgentPermissionsController(
			new MockAgentPermissionsService({ latencyMs: 0 }),
		);
		const request = controller.load();
		expect(controller.getSnapshot()).toEqual({ status: "loading" });
		await request;

		const state = controller.getSnapshot();
		expect(state.status).toBe("ready");
		if (!("snapshot" in state)) return;
		expect(state.snapshot.grants).toEqual([]);
		expect(hasAllAgentReadPermissions(state.snapshot)).toBe(false);
	});

	test("enables and revokes calendar and planning reads as one versioned setting", async () => {
		const controller = new AgentPermissionsController(
			new MockAgentPermissionsService({
				latencyMs: 0,
				now: () => 1_800_000_000_000,
			}),
		);
		await controller.load();
		await controller.setEnabled(true);

		let state = controller.getSnapshot();
		expect(state).toMatchObject({
			status: "success",
			message: "已启用本地 Agent 读取授权。",
		});
		if (!("snapshot" in state)) return;
		expect(state.snapshot).toEqual({
			grants: [...AGENT_READ_PERMISSION_IDS],
			revision: 1,
			updatedAtMs: 1_800_000_000_000,
		});

		await controller.setEnabled(false);
		state = controller.getSnapshot();
		expect(state).toMatchObject({
			status: "success",
			message: "已撤销本地 Agent 读取授权。",
		});
		if (!("snapshot" in state)) return;
		expect(state.snapshot.grants).toEqual([]);
		expect(state.snapshot.revision).toBe(2);
	});

	test("retains the authoritative snapshot and retry intent when a save fails", async () => {
		const controller = new AgentPermissionsController(
			new MockAgentPermissionsService({
				latencyMs: 0,
				saveFailureCount: 1,
			}),
		);
		await controller.load();
		expect(await controller.setEnabled(true)).toBeNull();

		let state = controller.getSnapshot();
		expect(state).toMatchObject({
			status: "error",
			stage: "save",
			requestedEnabled: true,
			message: "未能更改 Agent 授权，已保留原来的设置。",
		});
		if (!("snapshot" in state)) return;
		expect(state.snapshot.grants).toEqual([]);

		await controller.retry();
		state = controller.getSnapshot();
		expect(state.status).toBe("success");
		if (!("snapshot" in state)) return;
		expect(state.snapshot.grants).toEqual([...AGENT_READ_PERMISSION_IDS]);
	});

	test("renders an explicit retryable load failure instead of assuming authorization", async () => {
		const controller = new AgentPermissionsController(
			new MockAgentPermissionsService({
				latencyMs: 0,
				loadFailure: "offline",
			}),
		);
		expect(await controller.load()).toBeNull();
		expect(controller.getSnapshot()).toEqual({
			status: "error",
			stage: "load",
			message: "当前设备离线，暂时无法读取 Agent 授权。",
			retryable: true,
		});
	});
});

describe("ElectrobunAgentPermissionsService", () => {
	test("submits only enabled and expectedRevision, never a renderer account id", async () => {
		let received: unknown = null;
		const service = new ElectrobunAgentPermissionsService({
			async getAgentReadPermissions() {
				return {
					kind: "success",
					data: { grants: [], revision: 4, updatedAtMs: null },
				};
			},
			async setAgentReadPermissions(request) {
				received = request;
				return {
					kind: "success",
					data: {
						grants: [...AGENT_READ_PERMISSION_IDS],
						revision: 5,
						updatedAtMs: 10,
					},
				};
			},
		});

		expect(await service.load()).toEqual({
			grants: [],
			revision: 4,
			updatedAtMs: null,
		});
		expect(await service.setEnabled(true, 4)).toMatchObject({ revision: 5 });
		expect(received).toEqual({ enabled: true, expectedRevision: 4 });
		expect(JSON.stringify(received)).not.toContain("account");
	});

	test("rejects malformed snapshots and maps version conflicts", async () => {
		const malformed = new ElectrobunAgentPermissionsService({
			async getAgentReadPermissions() {
				return {
					kind: "success",
					data: {
						grants: ["agent.browser.read"],
						revision: 0,
						updatedAtMs: null,
					},
				};
			},
			async setAgentReadPermissions() {
				throw new Error("unused");
			},
		});
		await expect(malformed.load()).rejects.toMatchObject({
			kind: "invalid-response",
		});

		const conflict = new ElectrobunAgentPermissionsService({
			async getAgentReadPermissions() {
				throw new Error("unused");
			},
			async setAgentReadPermissions() {
				return {
					kind: "error",
					failure: "version-conflict",
					message: "stale",
					currentRevision: 9,
				};
			},
		});
		await expect(conflict.setEnabled(false, 8)).rejects.toEqual(
			expect.objectContaining({
				kind: "version-conflict",
				currentRevision: 9,
			}),
		);
	});
});
