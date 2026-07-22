import { describe, expect, test } from "bun:test";
import {
	PetStateArbiter,
	petStateForInteraction,
	petStateForRuntime,
	petStateForToolEvent,
	petStateHoldForInteraction,
	petStateHoldForToolEvent,
} from "../src/bun/pet-state";
import type { LocalRuntimeStatus, LocalToolEvent } from "../src/agent/local-protocol";
import type { PetState } from "../src/shared/contracts";

function status(overrides: Partial<LocalRuntimeStatus>): LocalRuntimeStatus {
	return { state: "ready", pid: 42, activeCalls: 0, lastError: null, ...overrides };
}

function event(kind: LocalToolEvent["event"]): LocalToolEvent {
	return { event: kind, callId: "call-1", data: { name: "demo.wait" } };
}

describe("production pet state mapping", () => {
	test("maps runtime lifecycle to explicit semantic actions", () => {
		expect(petStateForRuntime(status({ state: "starting" })).action).toBe("searching");
		expect(petStateForRuntime(status({ state: "ready" })).action).toBe("idle");
		expect(petStateForRuntime(status({ activeCalls: 2 })).action).toBe("loading");
		expect(petStateForRuntime(status({ state: "degraded" })).action).toBe(
			"networkDisconnected",
		);
	});

	test("maps tool progress, result, failure, and cancellation actions", () => {
		expect(petStateForToolEvent(event("tool.started")).action).toBe("searching");
		expect(petStateForToolEvent(event("tool.progress")).action).toBe("loading");
		expect(petStateForToolEvent(event("tool.completed")).action).toBe("taskComplete");
		expect(petStateForToolEvent(event("tool.failed")).action).toBe("operationFailed");
		expect(petStateForToolEvent(event("tool.cancelled")).action).toBe("wronged");
	});

	test("preserves the renderer action in production interaction feedback", () => {
		const petting = {
			kind: "pet",
			action: "petHead",
			modelId: "whale",
			zone: "head",
		} as const;
		expect(petStateForInteraction(petting)).toMatchObject({
			mood: "happy",
			message: "That feels nice!",
			action: "petHead",
		});
		expect(petStateHoldForInteraction(petting)).toBe(Number.POSITIVE_INFINITY);

		const rapid = {
			kind: "rapidClick",
			action: "rapidClickAnnoyed",
			modelId: "cat",
			zone: "body",
		} as const;
		expect(petStateForInteraction(rapid)?.action).toBe("rapidClickAnnoyed");
		expect(petStateHoldForInteraction(rapid)).toBe(1_800);
	});

	test("holds event actions across the immediately following runtime update", () => {
		let now = 1_000;
		const restores: Array<() => void> = [];
		const sent: PetState[] = [];
		const arbiter = new PetStateArbiter((state) => sent.push(state), {
			now: () => now,
			schedule: (callback) => {
				restores.push(callback);
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {
				restores.shift();
			},
		});

		arbiter.updateRuntime(status({ activeCalls: 0 }));
		arbiter.showToolEvent(event("tool.started"));
		arbiter.updateRuntime(status({ activeCalls: 1 }));
		expect(sent.map(({ action }) => action)).toEqual(["idle", "searching"]);

		now += petStateHoldForToolEvent(event("tool.started"));
		const finishStarted = restores.shift();
		expect(finishStarted).toBeDefined();
		finishStarted?.();
		expect(sent.map(({ action }) => action)).toEqual(["idle", "searching", "loading"]);

		arbiter.showToolEvent(event("tool.completed"));
		arbiter.updateRuntime(status({ activeCalls: 0 }));
		expect(sent.at(-1)?.action).toBe("taskComplete");
		arbiter.showToolEvent(event("tool.progress"));
		expect(sent.at(-1)?.action).toBe("taskComplete");

		now += petStateHoldForToolEvent(event("tool.completed"));
		const finishCompleted = restores.shift();
		expect(finishCompleted).toBeDefined();
		finishCompleted?.();
		expect(sent.at(-1)?.action).toBe("idle");
		arbiter.dispose();
	});

	test("keeps pointer interaction above progress until its release event", () => {
		const sent: PetState[] = [];
		const arbiter = new PetStateArbiter((state) => sent.push(state));
		arbiter.updateRuntime(status({ activeCalls: 1 }));
		arbiter.showInteraction({
			kind: "pet",
			action: "petHead",
			modelId: "whale",
			zone: "head",
		});
		arbiter.showToolEvent(event("tool.progress"));
		expect(sent.map(({ action }) => action)).toEqual(["loading", "petHead"]);

		arbiter.showInteraction({
			kind: "petEnd",
			action: "hoverLookAtPointer",
			modelId: "whale",
			zone: "head",
		});
		arbiter.showToolEvent(event("tool.progress"));
		expect(sent.at(-1)?.action).toBe("hoverLookAtPointer");

		arbiter.showInteraction({
			kind: "hoverEnd",
			action: "idle",
			modelId: "whale",
			zone: "head",
		});
		expect(sent.at(-1)?.action).toBe("loading");
		arbiter.dispose();
	});

	test("native drag polling can always finish an otherwise indefinite drag hold", () => {
		const restores: Array<() => void> = [];
		const sent: PetState[] = [];
		const arbiter = new PetStateArbiter((state) => sent.push(state), {
			schedule: (callback) => {
				restores.push(callback);
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {
				restores.shift();
			},
		});
		arbiter.updateRuntime(status({ activeCalls: 1 }));
		arbiter.showInteraction({
			kind: "dragStart",
			action: "dragged",
			modelId: "whale",
			zone: "body",
		});
		arbiter.finishNativeDrag();
		arbiter.showToolEvent(event("tool.progress"));
		expect(sent.map(({ action }) => action)).toEqual(["loading", "dragged", "drop"]);

		const finishDrop = restores.shift();
		expect(finishDrop).toBeDefined();
		finishDrop?.();
		expect(sent.at(-1)?.action).toBe("loading");
		arbiter.dispose();
	});

	test("lets a degraded runtime interrupt an event hold", () => {
		const sent: PetState[] = [];
		const arbiter = new PetStateArbiter((state) => sent.push(state));
		arbiter.showToolEvent(event("tool.completed"));
		arbiter.updateRuntime(status({ state: "degraded", lastError: "offline" }));
		expect(sent.map(({ action }) => action)).toEqual([
			"taskComplete",
			"networkDisconnected",
		]);
		arbiter.dispose();
	});

	test("a remounted pet view clears an orphaned pointer hold", () => {
		const sent: PetState[] = [];
		const arbiter = new PetStateArbiter((state) => sent.push(state));
		arbiter.showInteraction({
			kind: "pet",
			action: "petHead",
			modelId: "whale",
			zone: "head",
		});
		arbiter.resetToRuntime(status({ activeCalls: 1 }));
		expect(sent.map(({ action }) => action)).toEqual(["petHead", "loading"]);
		arbiter.dispose();
	});
});
