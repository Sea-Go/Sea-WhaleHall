import { describe, expect, test } from "bun:test";
import { buildPetProactivePrompt } from "../src/shared/pet-chat";
import { PetChatController, type PetChatPort } from "../src/views/pet/chat";

function harness() {
	const sent: {
		start: { requestId: string; text: string }[];
		cancel: unknown[];
		states: string[];
	} = { start: [], cancel: [], states: [] };
	const port: PetChatPort = {
		startTurn: (input) => {
			sent.start.push(input);
		},
		cancelTurn: (input) => {
			sent.cancel.push(input);
		},
		reportState: (state) => {
			sent.states.push(
				`${state.kind}${state.detail ? `:${state.detail}` : ""}`,
			);
		},
	};
	const controller = new PetChatController(port);
	return { controller, sent };
}

function deltaEvent(delta: string, revision = 1): unknown {
	return {
		runId: "run-1",
		revision,
		event: { type: "conversation.message.delta", delta },
	};
}

function completedEvent(): unknown {
	return {
		runId: "run-1",
		revision: 9,
		event: { type: "run.completed" },
	};
}

describe("PetChatController", () => {
	test("user turns stream and complete with user origin", () => {
		const { controller, sent } = harness();
		controller.setAvailable(true);
		controller.startTurn("你好");
		expect(sent.start).toHaveLength(1);
		const requestId = sent.start[0]?.requestId ?? "";
		expect(controller.getState()).toMatchObject({
			kind: "running",
			origin: "user",
		});

		controller.applyEvent(requestId, deltaEvent("大肥鱼"));
		controller.applyEvent(requestId, deltaEvent("回答", 2));
		expect(controller.getState()).toMatchObject({
			kind: "running",
			streaming: "大肥鱼回答",
		});

		controller.applyEvent(requestId, completedEvent());
		expect(controller.getState()).toMatchObject({
			kind: "done",
			answer: "大肥鱼回答",
			origin: "user",
		});
	});

	test("proactive turns enter via enterProactiveTurn and keep proactive origin", () => {
		const { controller, sent } = harness();
		controller.setAvailable(true);
		controller.enterProactiveTurn("pet-proactive-1");
		expect(sent.start).toHaveLength(0); // 主动轮不由渲染器发起
		expect(controller.getState()).toMatchObject({
			kind: "running",
			requestId: "pet-proactive-1",
			origin: "proactive",
		});

		controller.applyEvent("pet-proactive-1", deltaEvent("我在看"));
		controller.applyEvent("pet-proactive-1", deltaEvent("你的活动", 2));
		expect(controller.getState()).toMatchObject({
			streaming: "我在看你的活动",
		});

		controller.applyEvent("pet-proactive-1", completedEvent());
		expect(controller.getState()).toMatchObject({
			kind: "done",
			answer: "我在看你的活动",
			origin: "proactive",
		});
	});
});
