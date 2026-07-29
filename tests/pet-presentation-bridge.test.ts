import { describe, expect, test } from "bun:test";
import { PlanningPetCoordinator } from "../src/views/client/app/PlanningPetCoordinator";
import type {
	PetBridgeDiagnosticLogger,
	PetPresentationBridge,
	PetPresentationEvent,
} from "../src/views/client/features/pet-bridge/public";
import { PlanningController } from "../src/views/client/features/planning/PlanningController";
import { MockCalendarService } from "../src/views/client/infrastructure/calendar/MockCalendarService";
import { ElectrobunPetPresentationBridge } from "../src/views/client/infrastructure/pet-bridge/ElectrobunPetPresentationBridge";
import { CalendarPlanningGateway } from "../src/views/client/infrastructure/planning/CalendarPlanningGateway";
import { MockPlanningGenerationService } from "../src/views/client/infrastructure/planning/MockPlanningGenerationService";

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
	test("maps planning generation transitions without coupling the controller to RPC", async () => {
		const events: PetPresentationEvent[] = [];
		const bridge = recordingBridge(events);
		const generator = new MockPlanningGenerationService({ latencyMs: 0 });
		const controller = planningController(generator);
		const coordinator = new PlanningPetCoordinator(controller, bridge);
		coordinator.start();
		fillPlanningInput(controller);
		await controller.generate();
		coordinator.stop();

		expect(events).toEqual([
			{ kind: "plan-generation-started" },
			{ kind: "plan-generation-succeeded" },
		]);
		expect(controller.getSnapshot().status).toBe("review");
	});

	test("maps failure and never lets a rejected presentation block planning", async () => {
		const generator = new MockPlanningGenerationService({ latencyMs: 0 });
		generator.failNextGeneration();
		const controller = planningController(generator);
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
		fillPlanningInput(controller);
		await controller.generate();
		coordinator.stop();

		expect(attempted).toEqual([
			{ kind: "plan-generation-started" },
			{ kind: "plan-generation-failed" },
		]);
		expect(controller.getSnapshot().status).toBe("generation-error");
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

function planningController(
	generator: MockPlanningGenerationService,
): PlanningController {
	const calendar = new MockCalendarService({ latencyMs: 0 });
	return new PlanningController(
		generator,
		new CalendarPlanningGateway(calendar),
		() => "2026-07-29",
		() => "Asia/Shanghai",
		() => "pet-plan",
	);
}

function fillPlanningInput(controller: PlanningController): void {
	controller.start();
	controller.updateInput({ goal: "完成个人作品集并准备求职材料" });
	controller.next();
	controller.updateInput({ type: "short-term" });
	controller.next();
	controller.updateInput({
		deadline: "2026-08-05",
		weeklyCapacityHours: 6,
		preferredDayPart: "evening",
	});
}
