import { describe, expect, test } from "bun:test";
import { PlanningPetCoordinator } from "../src/views/client/app/PlanningPetCoordinator";
import type {
	PetBridgeDiagnosticLogger,
	PetPresentationBridge,
	PetPresentationEvent,
} from "../src/views/client/features/pet-bridge/public";
import type { PlanView } from "../src/views/client/features/planning/domain";
import { PlanningController } from "../src/views/client/features/planning/PlanningController";
import {
	type PlanningService,
	PlanningServiceError,
} from "../src/views/client/features/planning/planning-service";
import { ElectrobunPetPresentationBridge } from "../src/views/client/infrastructure/pet-bridge/ElectrobunPetPresentationBridge";

describe("ElectrobunPetPresentationBridge", () => {
	test("delivers typed presentation and visibility calls through its transport", async () => {
		const events: PetPresentationEvent[] = [];
		const visibility: boolean[] = [];
		const bridge = new ElectrobunPetPresentationBridge({
			runtimeAvailable: () => true,
			loadTransport: async () => ({
				async present(event) {
					events.push(event);
				},
				async setVisible(value) {
					visibility.push(value);
				},
			}),
		});

		await bridge.present({ kind: "focus-started" });
		await bridge.setVisible(false);
		expect(events).toEqual([{ kind: "focus-started" }]);
		expect(visibility).toEqual([false]);
	});

	test("silently degrades and records only sanitized diagnostic context", async () => {
		const diagnostics: Array<{
			message: string;
			context: Parameters<PetBridgeDiagnosticLogger["warn"]>[1];
		}> = [];
		const bridge = new ElectrobunPetPresentationBridge({
			runtimeAvailable: () => true,
			loadTransport: async () => ({
				async present() {
					throw new Error("secret plan title and RPC endpoint");
				},
				async setVisible() {
					throw new Error("private native window details");
				},
			}),
			logger: {
				warn(message, context) {
					diagnostics.push({ message, context });
				},
			},
		});

		await expect(
			bridge.present({ kind: "plan-generation-failed" }),
		).resolves.toBeUndefined();
		await expect(bridge.setVisible(false)).resolves.toBeUndefined();
		expect(diagnostics).toEqual([
			{
				message: "[pet-bridge] presentation delivery failed",
				context: {
					operation: "present",
					eventKind: "plan-generation-failed",
					category: "transport",
				},
			},
			{
				message: "[pet-bridge] visibility delivery failed",
				context: {
					operation: "set-visible",
					category: "transport",
				},
			},
		]);
		expect(JSON.stringify(diagnostics)).not.toContain("secret plan title");
		expect(JSON.stringify(diagnostics)).not.toContain("endpoint");
	});

	test("does not load Electrobun transport in standalone browser previews", async () => {
		let transportLoads = 0;
		const bridge = new ElectrobunPetPresentationBridge({
			runtimeAvailable: () => false,
			loadTransport: async () => {
				transportLoads += 1;
				throw new Error("must not load");
			},
		});
		await bridge.present({ kind: "user-inactive" });
		await bridge.setVisible(true);
		expect(transportLoads).toBe(0);
	});
});

describe("PlanningPetCoordinator", () => {
	test("maps conversational analysis transitions without coupling the controller to RPC", async () => {
		const events: PetPresentationEvent[] = [];
		const bridge = recordingBridge(events);
		const controller = new PlanningController(new PetPlanningService());
		await controller.initialize();
		const coordinator = new PlanningPetCoordinator(controller, bridge);
		coordinator.start();
		controller.updateCreateInput({ goal: "完成个人作品集" });
		await controller.createPlanDraft();
		coordinator.stop();

		expect(events).toEqual([
			{ kind: "plan-generation-started" },
			{ kind: "plan-generation-succeeded" },
		]);
		expect(controller.getSnapshot().status).toBe("draft");
	});

	test("maps failure and never lets a rejected presentation block planning", async () => {
		const controller = new PlanningController(new PetPlanningService(true));
		await controller.initialize();
		const attempted: PetPresentationEvent[] = [];
		const bridge: PetPresentationBridge = {
			async present(event) {
				attempted.push(event);
				throw new Error("pet unavailable");
			},
			async setVisible() {},
		};
		const coordinator = new PlanningPetCoordinator(controller, bridge);
		coordinator.start();
		controller.updateCreateInput({ goal: "完成个人作品集" });
		await controller.createPlanDraft();
		coordinator.stop();

		expect(attempted).toEqual([
			{ kind: "plan-generation-started" },
			{ kind: "plan-generation-failed" },
		]);
		expect(controller.getSnapshot().status).toBe("model-unavailable");
	});
});

function recordingBridge(
	events: PetPresentationEvent[],
): PetPresentationBridge {
	return {
		async present(event) {
			events.push(event);
		},
		async setVisible() {},
	};
}

class PetPlanningService implements PlanningService {
	private plan: PlanView | null = null;
	constructor(private readonly fail = false) {}
	subscribe() {
		return () => {};
	}
	async listPlans() {
		return this.plan
			? [
					{
						id: this.plan.id,
						title: this.plan.title,
						goal: this.plan.goal,
						status: this.plan.status,
						type: this.plan.type,
						version: this.plan.version,
						estimatedCompletionDate: null,
						confidence: null,
						updatedAt: this.plan.updatedAt,
					},
				]
			: [];
	}
	async getPlan() {
		if (!this.plan) throw new Error("missing plan");
		return this.plan;
	}
	async createPlanDraft(
		request: Parameters<PlanningService["createPlanDraft"]>[0],
	) {
		if (this.fail) {
			throw new PlanningServiceError("model-unavailable", "model offline");
		}
		this.plan = {
			id: "pet-plan",
			title: request.input.goal,
			goal: request.input.goal,
			status: "draft",
			type: null,
			version: 1,
			timeZone: "Asia/Shanghai",
			startToday: request.input.startToday,
			effectiveDate: null,
			estimate: null,
			revision: null,
			messages: [],
			tasks: [],
			monitoring: {
				authorized: false,
				enabled: false,
				mode: "manual-only",
				coverage: "unavailable",
				message: "仅使用手动进度",
			},
			pendingObservations: [],
			adjustments: [],
			notifications: [],
			updatedAt: "2026-08-13T00:00:00Z",
		};
		return { planId: this.plan.id };
	}
	async sendPlanMessage() {}
	async confirmPlanRevision() {}
	async setTaskStatus() {}
	async confirmObservationAttribution() {}
	async pausePlan() {}
	async resumePlan() {}
	async completePlan() {}
	async archivePlan() {}
	async undoPlanAdjustment() {}
	async retryPendingAnalysis() {}
}
