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


});

describe("ElectrobunAgentPermissionsService", () => {

});
