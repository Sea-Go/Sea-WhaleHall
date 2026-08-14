import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { buildAgentHost } from "../scripts/build-agent-host";
import {
	ContentLengthFrameParser,
	encodeContentLengthFrame,
} from "../src/agent/mastra-host/framing";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	type AgentRunEventFrame,
	isRecord,
	MAX_MODEL_RELAY_CHUNK_BYTES,
	type ModelRelayOpenParams,
	type ProtocolMessage,
	SIDECAR_HOST_METHODS,
	type SidecarHostRequest,
	successResponse,
} from "../src/agent/mastra-host/protocol";

let sidecarPath = "";
let sidecarNodePath = "";

beforeAll(async () => {
	sidecarPath = await buildAgentHost();
	sidecarNodePath = resolve(
		dirname(sidecarPath),
		process.platform === "win32" ? "node.exe" : "node",
	);
}, 30_000);

afterAll(() => {
	sidecarPath = "";
	sidecarNodePath = "";
});

describe("Mastra Node sidecar", () => {
	test("streams conversation and authoritative structured planning through host calls", async () => {
		const host = new FakeHost();
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();

		const conversationResponse = await harness.request("conversation.start", {
			runId: "conversation-run-1",
			conversationId: "conversation-1",
			resourceId: "installation-1",
			message: "请用一句话说明今天的重点。",
			expectedVersion: 0,
		});
		expect(conversationResponse).toMatchObject({
			ok: true,
			result: { accepted: true },
		});
		const conversationTerminal =
			await harness.waitForRunTerminal("conversation-run-1");
		expect(conversationTerminal.terminalState).toBe("completed");
		expect(conversationTerminal.event).toMatchObject({
			kind: "run.completed",
			result: {
				conversationId: "conversation-1",
				message: { role: "assistant", content: "今天先完成最重要的一件事。" },
			},
		});
		const conversationEvents = harness.runEvents("conversation-run-1");
		expect(conversationEvents.map((event) => event.sequence)).toEqual(
			conversationEvents.map((_, index) => index + 1),
		);
		expect(conversationEvents.map((event) => event.version)).toEqual(
			conversationEvents.map((_, index) => index + 1),
		);
		expect(
			conversationEvents.some(
				(event) => event.event.kind === "conversation.text.delta",
			),
		).toBe(true);
		const snapshot = await harness.request("run.snapshot", {
			runId: "conversation-run-1",
		});
		expect(snapshot).toMatchObject({
			ok: true,
			result: { runId: "conversation-run-1", terminalState: "completed" },
		});
		expect(host.calls).toContain("memory/load");
		expect(host.calls).toContain("memory/append");

		const planningInput = {
			goal: "在年底前完成 WhaleHall Beta",
			planType: "long-term" as const,
			deadline: "2099-12-31",
			priority: "high" as const,
			weeklyCapacityHours: 10,
			unavailableDays: ["Sunday"],
			preferredSessionMinutes: 60 as const,
			preferredDayPart: "morning" as const,
			timeZone: "Asia/Shanghai",
		};
		await harness.request(
			"planning.start",
			{
				runId: "planning-run-1",
				sessionId: "planning-session-1",
				input: planningInput,
				expectedVersion: 0,
			},
			"host:planning.start:durable-1",
		);
		const clarification = await harness.waitForRunSuspended("planning-run-1");
		expect(clarification.terminalState).toBeNull();
		expect(clarification.event).toMatchObject({
			kind: "run.suspended",
			suspendPayload: {
				kind: "planning.clarification",
				status: "clarifying",
				clarificationRounds: 1,
				questions: [{ key: "expected_outcome" }],
			},
		});

		const mismatchedOrigin = await harness.request("planning.answer", {
			runId: "planning-run-1",
			sessionId: "planning-session-1",
			originatingRequestId: "host:planning.answer:random-command",
			answers: [
				{ questionKey: "expected_outcome", answerText: "不可接受的来源" },
			],
			expectedVersion: 1,
		});
		expect(mismatchedOrigin).toMatchObject({
			ok: false,
			error: { code: "RUN_CONFLICT" },
		});

		await harness.request("planning.answer", {
			runId: "planning-run-1",
			sessionId: "planning-session-1",
			originatingRequestId: "host:planning.start:durable-1",
			answers: [
				{ questionKey: "expected_outcome", answerText: "可安装并通过核心验收" },
			],
			expectedVersion: 1,
		});
		const draft = await harness.waitForRunTerminal("planning-run-1");
		expect(draft.terminalState).toBe("completed");
		expect(draft.event).toMatchObject({
			kind: "run.completed",
			result: {
				status: "draft",
				draft: {
					calendarRevision: 7,
					schedule: [
						{
							taskId: "task-1",
							start: "2099-12-01T09:00:00+08:00",
							end: "2099-12-01T10:00:00+08:00",
							timeZone: "Asia/Shanghai",
						},
					],
					unscheduledTaskIds: [],
				},
			},
		});
		expect(
			harness
				.runEvents("planning-run-1")
				.some((event) => event.event.kind === "planning.object.delta"),
		).toBe(true);
		const planningEvents = harness.runEvents("planning-run-1");
		expect(planningEvents.map((event) => event.sequence)).toEqual(
			planningEvents.map((_, index) => index + 1),
		);
		expect(
			planningEvents.some((event) => event.event.kind === "run.resumed"),
		).toBe(true);
		expect(
			host.calls.filter((method) => method === "calendar/query"),
		).toHaveLength(2);
		expect(host.calls).toContain("workflow/start");
		expect(host.calls).toContain("workflow/resume");
		expect(host.calls).toContain("planning/load");
		expect(host.calls).toContain("planning/validate");
		expect(
			host.calls.filter((method) => method === "planning/save"),
		).toHaveLength(2);
		expect(host.modelBodies.every((body) => body.stream === true)).toBe(true);

		await harness.shutdown();
	}, 30_000);

	test("loads required native Skills locally without exposing Skill tools to the reflection model", async () => {
		const host = new FakeHost();
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();

		const response = await harness.request("reflection.analyze", {
			invocationId: "activity-reflection-without-skills",
			requestId: "activity-window-without-skills",
			signalSegmentIds: ["segment-1"],
			candidateActivities: ["development"],
			userPrompt:
				'COMPRESSED_ACTIVITY_EVENTS_JSON=[{"time":"时间未知","tools":"synthetic","message":"synthetic only"}]',
		});
		expect(response).toMatchObject({
			ok: true,
			result: { score: 0.7 },
		});
		expect(host.modelBodies).toHaveLength(1);
		const body = host.modelBodies[0];
		expect(JSON.stringify(body?.messages)).toContain(
			"# 已加载的活动反思分析 Skill",
		);
		expect(JSON.stringify(body?.messages)).toContain(
			"# 已加载的活动反思评分 Skill",
		);
		expect(JSON.stringify(body?.messages)).not.toContain(
			resolve(import.meta.dir, ".."),
		);
		expect(body?.tools).toBeUndefined();
		await harness.shutdown();
	}, 30_000);

	test("uses the conversation Agent for proactive feedback without memory or local Tools", async () => {
		const host = new FakeHost();
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();
		await harness.request("activity.start", {
			runId: "activity-run-1",
			activityJobId: "activity-job-1",
			consumedScore: 0,
			analyses: [
				{
					request_id: "worker-request-1",
					score: 0.8,
					score_reason: "goal-relevant activity",
					events: [
						{
							source_event_ids: ["sealed-window-id"],
							activity: "development",
							goal_relevance: "direct",
							confidence: 0.9,
							reason_codes: ["worker"],
							evidence: ["Worker-produced evidence"],
							started_at_ms: 1,
							ended_at_ms: 2,
						},
					],
				},
			],
		});
		const terminal = await harness.waitForRunTerminal("activity-run-1");
		expect(terminal.event).toMatchObject({
			kind: "run.completed",
			result: {
				activityJobId: "activity-job-1",
				summary: "今天先完成最重要的一件事。",
			},
		});
		expect(host.calls).toContain("model/relay.open");
		expect(
			host.calls.some(
				(method) =>
					method.startsWith("tool/") ||
					method.startsWith("memory/") ||
					method.startsWith("calendar/") ||
					method.startsWith("planning/"),
			),
		).toBeFalse();
		const modelInput = JSON.stringify(host.modelBodies[0]?.messages);
		expect(modelInput).toContain("WhaleHall 桌面助手");
		expect(modelInput).toContain("以 WhaleHall 对话助手一致的人格");
		expect(modelInput).toContain("Worker-produced evidence");
		expect(modelInput).not.toContain("raw_event");
		expect(host.modelBodies[0]?.tools).toBeUndefined();
		await harness.shutdown();
	}, 30_000);

	test("classifies an activity Tool response as deterministic invalid output", async () => {
		const host = new FakeHost({ activityToolViolation: true });
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();
		await harness.request("activity.start", {
			runId: "activity-run-tool-violation",
			activityJobId: "activity-job-tool-violation",
			consumedScore: 1,
			analyses: [
				{
					request_id: "worker-request-tool-violation",
					score: 1,
					score_reason: "goal-relevant activity",
					events: [
						{
							source_event_ids: ["sealed-window-tool-violation"],
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
		const terminal = await harness.waitForRunTerminal(
			"activity-run-tool-violation",
		);
		expect(terminal.event).toMatchObject({
			kind: "run.failed",
			error: {
				code: "ACTIVITY_OUTPUT_INVALID",
				retryable: false,
			},
		});
		await harness.shutdown();
	}, 30_000);

	test("runs client-owned compressed activity reflection through a non-persistent Mastra workflow", async () => {
		const host = new FakeHost();
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();

		const response = await harness.request("reflection.analyze", {
			invocationId: "activity-reflection-window-1",
			requestId: "activity-window-request-1",
			signalSegmentIds: ["segment-1"],
			candidateActivities: ["development"],
			userPrompt:
				'COMPRESSED_ACTIVITY_EVENTS_JSON=[{"time":"时间未知","tools":"synthetic","message":"private raw activity"}]\nACTIVITY_CONTEXT_JSON={}',
		});
		expect(response).toMatchObject({
			ok: true,
			result: {
				events: [{ action: "推测：正在进行编程", activity: "development" }],
				score: 0.7,
			},
		});
		expect(host.calls).toContain("model/relay.open");
		const reflectionBodies = host.modelBodies;
		expect(reflectionBodies).toHaveLength(1);
		const reflectionBody = reflectionBodies[0];
		expect(JSON.stringify(reflectionBody?.messages)).toContain(
			"private raw activity",
		);
		expect(JSON.stringify(reflectionBody?.messages)).toContain(
			"# 活动反思分析",
		);
		expect(JSON.stringify(reflectionBody?.messages)).toContain(
			"# 活动反思评分",
		);
		expect(JSON.stringify(reflectionBody?.messages)).not.toContain(
			"# Available Skills",
		);
		expect(reflectionBody?.tools).toBeUndefined();
		expect(reflectionBody?.response_format).toBeDefined();
		expect(reflectionBody?.stream).not.toBe(true);
		expect(host.workflowSnapshotCalls).toEqual([]);

		await harness.shutdown();
	}, 30_000);

	test("classifies a semantic reflection schema violation as invalid output", async () => {
		const host = new FakeHost({ reflectionSensorOnlyAction: true });
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();

		const response = await harness.request("reflection.analyze", {
			invocationId: "activity-reflection-invalid-output",
			requestId: "activity-window-invalid-output",
			signalSegmentIds: ["segment-1"],
			candidateActivities: ["development"],
			userPrompt:
				'COMPRESSED_ACTIVITY_EVENTS_JSON=[{"time":"时间未知","tools":"synthetic","message":"synthetic observation"}]\nACTIVITY_CONTEXT_JSON={}',
		});
		expect(response).toMatchObject({
			ok: false,
			error: {
				code: "ACTIVITY_OUTPUT_INVALID",
				retryable: false,
			},
		});

		await harness.shutdown();
	}, 30_000);

	test("recalls Bun-owned conversation history through Mastra Memory", async () => {
		const host = new FakeHost({
			memoryMessages: [
				{ role: "user", content: "请记住项目代号是蓝鲸。" },
				{ role: "assistant", content: "已记住项目代号。" },
			],
		});
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();
		await harness.request("conversation.start", {
			runId: "memory-run",
			conversationId: "memory-conversation",
			resourceId: "installation-1",
			message: "项目代号是什么？",
			expectedVersion: 2,
		});
		const terminal = await harness.waitForRunTerminal("memory-run");
		expect(terminal.event).toMatchObject({
			kind: "run.completed",
			result: { memoryVersion: 4 },
		});
		const modelMessages = JSON.stringify(host.modelBodies[0]?.messages);
		expect(modelMessages).toContain("请记住项目代号是蓝鲸。");
		expect(modelMessages).toContain("已记住项目代号。");
		expect(modelMessages.indexOf("请记住项目代号是蓝鲸。")).toBeLessThan(
			modelMessages.indexOf("已记住项目代号。"),
		);
		expect(modelMessages.indexOf("已记住项目代号。")).toBeLessThan(
			modelMessages.indexOf("项目代号是什么？"),
		);
		const appendedMessages = host.lastMemoryAppend?.messages;
		expect(
			Array.isArray(appendedMessages) ? appendedMessages : [],
		).toHaveLength(2);
		expect(host.lastMemoryAppend).toMatchObject({
			expectedVersion: 2,
			messages: expect.arrayContaining([
				{ role: "assistant", content: "今天先完成最重要的一件事。" },
			]),
		});
		await harness.shutdown();
	}, 30_000);

	test("rehydrates a suspended planning Workflow after the Sidecar restarts", async () => {
		const host = new FakeHost();
		const firstHarness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => firstHarness.send(message)),
		);
		await firstHarness.initialize();
		await firstHarness.request(
			"planning.start",
			{
				runId: "planning-restart-run",
				sessionId: "planning-restart-session",
				input: planningInputFixture(),
				expectedVersion: 0,
			},
			"planning-restart-origin",
		);
		await firstHarness.waitForRunSuspended("planning-restart-run");
		const suspendedSnapshot = host.workflowSnapshotCalls.findLast(
			(call) =>
				call.method === "workflow/snapshot.persist" &&
				call.params.workflowName === "task-planning" &&
				isRecord(call.params.snapshot) &&
				call.params.snapshot.status === "suspended",
		);
		expect(suspendedSnapshot?.params).toMatchObject({
			workflowName: "task-planning",
			runId: "workflow-1",
			snapshot: {
				status: "suspended",
				resumeLabels: {
					"planning.clarification": { stepId: "planning-cycle" },
				},
			},
		});
		await firstHarness.shutdown();

		const callsBeforeRestart = host.workflowSnapshotCalls.length;
		const secondHarness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => secondHarness.send(message)),
		);
		await secondHarness.initialize();
		const modelCallsBeforeRecovery = host.modelBodies.length;
		await secondHarness.request("planning.answer", {
			runId: "different-planning-run",
			sessionId: "planning-restart-session",
			originatingRequestId: "planning-restart-origin-different",
			answers: [
				{ questionKey: "expected_outcome", answerText: "尝试串用会话" },
			],
			expectedVersion: 1,
		});
		const rejected = await secondHarness.waitForRunTerminal(
			"different-planning-run",
		);
		expect(rejected.event).toMatchObject({
			kind: "run.failed",
			error: { code: "SESSION_NOT_FOUND" },
		});
		expect(host.modelBodies).toHaveLength(modelCallsBeforeRecovery);
		const accepted = await secondHarness.request("planning.answer", {
			runId: "planning-restart-run",
			sessionId: "planning-restart-session",
			originatingRequestId: "planning-restart-origin",
			answers: [
				{ questionKey: "expected_outcome", answerText: "可安装并通过核心验收" },
			],
			expectedVersion: 1,
		});
		expect(accepted).toMatchObject({
			ok: true,
			result: { accepted: true, runId: "planning-restart-run" },
		});
		const terminal = await secondHarness.waitForRunTerminal(
			"planning-restart-run",
		);
		expect(terminal.event).toMatchObject({
			kind: "run.completed",
			result: { status: "draft", draft: { phases: [{ id: "phase-1" }] } },
		});
		expect(host.modelOrigins.at(-1)).toBe("planning-restart-origin");
		const recoveryCalls = host.workflowSnapshotCalls.slice(callsBeforeRestart);
		expect(
			recoveryCalls.filter(
				(call) =>
					call.method === "workflow/snapshot.load" &&
					call.params.workflowName === "task-planning" &&
					call.params.runId === "workflow-1",
			),
		).toHaveLength(2);
		await secondHarness.shutdown();
	}, 30_000);

	test("proposes an approval-bound write Tool before executing it and resumes the same run", async () => {
		const host = new FakeHost({ toolApprovalScenario: true });
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();
		await harness.request(
			"conversation.start",
			{
				runId: "tool-run-1",
				conversationId: "tool-conversation-1",
				resourceId: "installation-1",
				message: "请创建一个明天上午的日程。",
				expectedVersion: 0,
			},
			"tool-run-origin",
		);

		const approvalEvent = (await harness.waitFor(
			(message) =>
				isRunEvent(message) &&
				message.runId === "tool-run-1" &&
				message.event.kind === "agent.tool.approval.required",
		)) as AgentRunEventFrame;
		expect(approvalEvent.event).toMatchObject({
			kind: "agent.tool.approval.required",
			toolCallId: "tool-call-1",
			toolName: "calendar.create_event",
			runVersion: 41,
			approval: {
				approvalId: "approval-1",
				inputDigest: "digest-1",
			},
		});
		expect(approvalEvent.event).not.toHaveProperty("arguments");
		await harness.waitForRunSuspended("tool-run-1");
		expect(host.calls).toContain("tool/propose");
		expect(host.calls).not.toContain("tool/call");
		expect(
			host.calls.filter((method) => method === "memory/append"),
		).toHaveLength(0);
		expect(
			host.workflowSnapshotCalls.some(
				(call) =>
					call.method === "workflow/snapshot.persist" &&
					call.params.workflowName === "agentic-loop" &&
					call.params.runId === "tool-run-1" &&
					isRecord(call.params.snapshot) &&
					call.params.snapshot.status === "suspended",
			),
		).toBe(true);
		const bypass = await harness.request("run.resume", {
			runId: "tool-run-1",
			originatingRequestId: "tool-run-origin",
			resumeData: { approved: true },
		});
		expect(bypass).toMatchObject({
			ok: false,
			error: { code: "RUN_NOT_RESUMABLE" },
		});
		const mismatchedOrigin = await harness.request("agent.approveTool", {
			runId: "tool-run-1",
			originatingRequestId: "tool-run-random-approval-command",
			toolCallId: "tool-call-1",
		});
		expect(mismatchedOrigin).toMatchObject({
			ok: false,
			error: { code: "RUN_CONFLICT" },
		});

		await harness.request("agent.approveTool", {
			runId: "tool-run-1",
			originatingRequestId: "tool-run-origin",
			toolCallId: "tool-call-1",
		});
		const terminal = await harness.waitForRunTerminal("tool-run-1");
		expect(terminal.terminalState).toBe("completed");
		expect(terminal.event).toMatchObject({
			kind: "run.completed",
			result: {
				message: { content: "我来处理。日程已经按你的要求创建。" },
			},
		});
		expect(
			host.modelOrigins.every((value) => value === "tool-run-origin"),
		).toBe(true);
		expect(host.calls).toContain("tool/call");
		expect(
			host.workflowSnapshotCalls.some(
				(call) =>
					call.method === "workflow/snapshot.load" &&
					call.params.workflowName === "agentic-loop" &&
					call.params.runId === "tool-run-1",
			),
		).toBe(true);
		expect(host.lastToolCall).toMatchObject({
			runId: "tool-run-1",
			toolCallId: "tool-call-1",
			name: "calendar.create_event",
			runVersion: 41,
			approvalId: "approval-1",
			inputDigest: "digest-1",
		});
		const toolEvents = harness.runEvents("tool-run-1");
		expect(toolEvents.map((event) => event.sequence)).toEqual(
			toolEvents.map((_, index) => index + 1),
		);
		expect(
			toolEvents
				.filter((event) => event.event.kind === "agent.tool.result")
				.every((event) => !("result" in event.event)),
		).toBe(true);
		await harness.shutdown();
	}, 30_000);

	test("auto-executes an allowlisted read Tool without proposing approval", async () => {
		const host = new FakeHost({ readToolScenario: true });
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();
		await harness.request("conversation.start", {
			runId: "read-tool-run",
			conversationId: "read-tool-conversation",
			resourceId: "installation-1",
			message: "当前目标是什么？",
			expectedVersion: 0,
		});
		const terminal = await harness.waitForRunTerminal("read-tool-run");
		expect(terminal.terminalState).toBe("completed");
		expect(host.calls).toContain("tool/call");
		expect(host.calls).not.toContain("tool/propose");
		expect(host.lastToolCall).toMatchObject({
			runId: "read-tool-run",
			toolCallId: "read-tool-call-1",
			name: "planning.get_active_goal",
			arguments: {},
		});
		expect(host.lastToolCall).not.toHaveProperty("approvalId");
		expect(
			harness
				.runEvents("read-tool-run")
				.some((event) => event.event.kind === "run.suspended"),
		).toBe(false);
		const firstModelBody = host.modelBodies[0];
		const toolNames = Array.isArray(firstModelBody?.tools)
			? firstModelBody.tools
					.map((tool) =>
						isRecord(tool) &&
						isRecord(tool.function) &&
						typeof tool.function.name === "string"
							? tool.function.name
							: null,
					)
					.filter((name): name is string => name !== null)
					.sort()
			: [];
		expect(toolNames).toEqual(
			[
				"calendar_commit_plan_schedule",
				"calendar_create_event",
				"calendar_delete_event",
				"calendar_list_events",
				"calendar_update_event",
				"planning_get_active_goal",
				"planning_get_active_plan",
				"planning_save_draft",
			].sort(),
		);
		await harness.shutdown();
	}, 30_000);

	test("declines an approval-bound write Tool without executing it", async () => {
		const host = new FakeHost({ toolApprovalScenario: true });
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();
		await harness.request(
			"conversation.start",
			{
				runId: "decline-tool-run",
				conversationId: "decline-tool-conversation",
				resourceId: "installation-1",
				message: "请创建一个明天上午的日程。",
				expectedVersion: 0,
			},
			"decline-tool-origin",
		);
		await harness.waitForRunSuspended("decline-tool-run");
		await harness.request("agent.declineTool", {
			runId: "decline-tool-run",
			originatingRequestId: "decline-tool-origin",
			toolCallId: "tool-call-1",
			reason: "用户拒绝",
		});
		const terminal = await harness.waitForRunTerminal("decline-tool-run");
		expect(terminal.terminalState).toBe("completed");
		expect(host.calls).not.toContain("tool/call");
		expect(
			harness
				.runEvents("decline-tool-run")
				.some(
					(event) =>
						event.event.kind === "run.resumed" &&
						event.event.decision === "decline",
				),
		).toBe(true);
		await harness.shutdown();
	}, 30_000);

	test("retries an invalid draft once and persists a conflict instead of failing the run", async () => {
		const host = new FakeHost({ planningConflictScenario: true });
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();
		await harness.request("planning.start", {
			runId: "planning-conflict-run",
			sessionId: "planning-conflict-session",
			input: planningInputFixture(),
			expectedVersion: 0,
		});
		const terminal = await harness.waitForRunTerminal("planning-conflict-run");
		expect(terminal.terminalState).toBe("completed");
		expect(terminal.event).toMatchObject({
			kind: "run.completed",
			result: {
				status: "conflict",
				draft: { calendarRevision: 8 },
				validationIssues: [
					{ code: "calendar-conflict", proposalId: "proposal-1" },
				],
			},
		});
		expect(
			host.calls.filter((method) => method === "calendar/query"),
		).toHaveLength(2);
		expect(
			host.calls.filter((method) => method === "planning/validate"),
		).toHaveLength(2);
		expect(
			host.modelBodies.filter((body) => body.response_format !== undefined),
		).toHaveLength(2);
		expect(
			host.calls.filter((method) => method === "planning/save"),
		).toHaveLength(1);
		expect(host.lastPlanningSave).toMatchObject({
			result: { status: "conflict", draft: { calendarRevision: 8 } },
		});
		expect(
			harness
				.runEvents("planning-conflict-run")
				.some((event) => event.event.kind === "run.failed"),
		).toBe(false);
		await harness.shutdown();
	}, 30_000);

	test("cancels an active run and aborts the in-flight model relay", async () => {
		const host = new FakeHost({ holdModelOpen: true });
		const harness = new SidecarHarness(sidecarPath, (request) =>
			host.handle(request, (message) => harness.send(message)),
		);
		await harness.initialize();
		await harness.request("conversation.start", {
			runId: "cancel-run-1",
			conversationId: "cancel-conversation",
			message: "等待模型",
			expectedVersion: 0,
		});
		await harness.waitFor(
			(message) =>
				isSidecarRequest(message) && message.method === "model/relay.open",
		);
		await harness.request("run.cancel", {
			runId: "cancel-run-1",
			reason: "用户停止生成",
		});
		const terminal = await harness.waitForRunTerminal("cancel-run-1");
		expect(terminal.terminalState).toBe("cancelled");
		expect(terminal.event).toEqual({
			kind: "run.cancelled",
			reason: "用户停止生成",
		});
		await harness.waitFor(
			(message) =>
				isSidecarRequest(message) && message.method === "model/relay.abort",
		);
		expect(host.calls).toContain("model/relay.abort");
		await harness.shutdown();
	}, 30_000);

	test("closes the Sidecar when a host response frame is malformed", async () => {
		const host = new FakeHost();
		const harness = new SidecarHarness(sidecarPath, async (request) => {
			if (request.method === "model/relay.open") {
				await harness.send({
					protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
					type: "response",
					requestId: request.requestId,
					ok: true,
				} as unknown as ProtocolMessage);
				return;
			}
			await host.handle(request, (message) => harness.send(message));
		});
		await harness.initialize();
		await harness.request("conversation.start", {
			runId: "malformed-response-run",
			conversationId: "malformed-response-conversation",
			message: "触发模型调用",
			expectedVersion: 0,
		});
		expect(await harness.waitForExit()).toBe(1);
	}, 30_000);
});

type HostHandler = (request: SidecarHostRequest) => Promise<void>;

class SidecarHarness {
	private readonly child;
	private readonly parser = new ContentLengthFrameParser();
	private readonly messages: unknown[] = [];
	private readonly waiters = new Set<{
		predicate: (message: unknown) => boolean;
		resolve: (message: unknown) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private readonly readTask: Promise<void>;
	private readFailure: Error | null = null;

	constructor(
		path: string,
		private readonly hostHandler: HostHandler,
	) {
		this.child = Bun.spawn([sidecarNodePath, path], {
			cwd: resolve(import.meta.dir, ".."),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.readTask = this.readLoop();
	}

	async initialize(): Promise<void> {
		const response = await this.request("runtime.initialize", {
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			client: { name: "mastra-host-test", version: "1" },
			model: {
				provider: "whalehall-test",
				modelId: "test-chat-model",
				supportsStructuredOutputs: true,
			},
			reflectionModel: {
				provider: "whalehall-activity-reflection",
				modelId: "test-reflection-model",
				supportsStructuredOutputs: true,
			},
		});
		expect(response).toMatchObject({
			ok: true,
			result: {
				service: "whalehall-agent-host",
				capabilities: {
					streaming: true,
					structuredPlanning: true,
					listensOnNetwork: false,
					methods: expect.arrayContaining([
						"conversation.start",
						"planning.start",
						"activity.start",
						"planning.answer",
						"agent.approveTool",
						"agent.declineTool",
						"run.cancel",
						"run.resume",
					]),
				},
			},
		});
	}

	async request(
		method: string,
		params: Record<string, unknown>,
		requestId = `host:${method}:${crypto.randomUUID()}`,
	): Promise<Record<string, unknown>> {
		await this.send({
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "request",
			requestId,
			method,
			params,
		} as ProtocolMessage);
		return (await this.waitFor(
			(message) =>
				isRecord(message) &&
				message.type === "response" &&
				message.requestId === requestId,
		)) as Record<string, unknown>;
	}

	async send(message: ProtocolMessage): Promise<void> {
		this.child.stdin.write(encodeContentLengthFrame(message));
		await this.child.stdin.flush();
	}

	waitFor(
		predicate: (message: unknown) => boolean,
		timeoutMs = 10_000,
	): Promise<unknown> {
		const existing = this.messages.find(predicate);
		if (existing !== undefined) return Promise.resolve(existing);
		if (this.readFailure) return Promise.reject(this.readFailure);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(
						new Error(
							`Timed out waiting for sidecar message. Seen: ${JSON.stringify(this.messages)}`,
						),
					);
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
	}

	async waitForRunTerminal(runId: string): Promise<AgentRunEventFrame> {
		return (await this.waitFor(
			(message) =>
				isRunEvent(message) &&
				message.runId === runId &&
				message.terminalState !== null,
		)) as AgentRunEventFrame;
	}

	async waitForRunSuspended(runId: string): Promise<AgentRunEventFrame> {
		return (await this.waitFor(
			(message) =>
				isRunEvent(message) &&
				message.runId === runId &&
				message.event.kind === "run.suspended",
		)) as AgentRunEventFrame;
	}

	runEvents(runId: string): AgentRunEventFrame[] {
		return this.messages.filter(
			(message): message is AgentRunEventFrame =>
				isRunEvent(message) && message.runId === runId,
		);
	}

	async shutdown(): Promise<void> {
		if (this.child.exitCode !== null) return;
		await this.request("runtime.shutdown", {});
		const exitCode = await Promise.race([
			this.child.exited,
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("Node sidecar did not exit after shutdown.")),
					5_000,
				),
			),
		]);
		if (exitCode !== 0) {
			const stderr = await new Response(this.child.stderr).text();
			throw new Error(`Node sidecar exited with ${exitCode}: ${stderr}`);
		}
		await this.readTask;
	}

	async waitForExit(): Promise<number> {
		return await Promise.race([
			this.child.exited,
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error("Node sidecar did not exit after a protocol failure."),
						),
					5_000,
				),
			),
		]);
	}

	private async readLoop(): Promise<void> {
		try {
			for await (const chunk of this.child.stdout) {
				for (const message of this.parser.push(chunk)) {
					this.messages.push(message);
					this.publish(message);
					if (isSidecarRequest(message)) await this.hostHandler(message);
				}
			}
			this.parser.finish();
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.readFailure = failure;
			for (const waiter of this.waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(failure);
			}
			this.waiters.clear();
			throw failure;
		}
	}

	private publish(message: unknown): void {
		for (const waiter of this.waiters) {
			if (!waiter.predicate(message)) continue;
			clearTimeout(waiter.timer);
			this.waiters.delete(waiter);
			waiter.resolve(message);
		}
	}
}

class FakeHost {
	readonly calls: string[] = [];
	readonly modelBodies: Array<Record<string, unknown>> = [];
	readonly modelOrigins: string[] = [];
	readonly workflowSnapshotCalls: Array<{
		method: string;
		params: Record<string, unknown>;
	}> = [];
	lastToolCall: Record<string, unknown> | null = null;
	lastPlanningSave: Record<string, unknown> | null = null;
	lastMemoryAppend: Record<string, unknown> | null = null;
	private planningModelCalls = 0;
	private toolModelCalls = 0;
	private calendarQueryCalls = 0;
	private planningValidationCalls = 0;
	private planningState: Record<string, unknown> | null = null;
	private readonly workflowSnapshots = new Map<
		string,
		{
			workflowName: string;
			runId: string;
			resourceId?: string;
			snapshot: Record<string, unknown>;
			createdAtMs: number;
			updatedAtMs: number;
		}
	>();

	constructor(
		private readonly options: {
			holdModelOpen?: boolean;
			activityToolViolation?: boolean;
			reflectionSensorOnlyAction?: boolean;
			toolApprovalScenario?: boolean;
			readToolScenario?: boolean;
			planningConflictScenario?: boolean;
			memoryMessages?: readonly {
				role: "user" | "assistant";
				content: string;
			}[];
		} = {},
	) {}

	async handle(
		request: SidecarHostRequest,
		send: (message: ProtocolMessage) => Promise<void>,
	): Promise<void> {
		this.calls.push(request.method);
		switch (request.method) {
			case "memory/load":
				await send(
					successResponse(request.requestId, {
						messages: structuredClone(this.options.memoryMessages ?? []),
						version: this.options.memoryMessages?.length ?? 0,
					}),
				);
				return;
			case "memory/append":
				this.lastMemoryAppend = structuredClone(request.params);
				await send(
					successResponse(request.requestId, {
						version: (this.options.memoryMessages?.length ?? 0) + 2,
					}),
				);
				return;
			case "workflow/start":
				await send(
					successResponse(request.requestId, { workflowRunId: "workflow-1" }),
				);
				return;
			case "workflow/resume":
				await send(successResponse(request.requestId, { resumed: true }));
				return;
			case "workflow/snapshot.persist":
			case "workflow/snapshot.load":
			case "workflow/snapshot.list":
			case "workflow/snapshot.get":
			case "workflow/snapshot.delete":
			case "workflow/snapshot.update-results":
			case "workflow/snapshot.update-state":
				await send(
					successResponse(
						request.requestId,
						this.handleWorkflowSnapshot(request.method, request.params),
					),
				);
				return;
			case "calendar/query":
				this.calendarQueryCalls += 1;
				await send(
					successResponse(request.requestId, {
						accountId: "calendar-account-1",
						revision:
							this.options.planningConflictScenario &&
							this.calendarQueryCalls > 1
								? 8
								: 7,
						timeZone: request.params.timeZone,
						fromDate: request.params.fromDate,
						toDateExclusive: request.params.toDateExclusive,
						events: [],
					}),
				);
				return;
			case "planning/load":
				await send(
					successResponse(
						request.requestId,
						this.planningState ?? {
							sessionId: "planning-session-1",
							runId: "planning-run-1",
							input: planningInputFixture(),
							answers: [],
							clarificationRounds: 1,
							workflowRunId: "workflow-1",
							version: 1,
						},
					),
				);
				return;
			case "planning/save": {
				this.lastPlanningSave = structuredClone(request.params);
				const expectedVersion = Number(request.params.expectedVersion);
				const version = expectedVersion + 1;
				this.planningState = { ...request.params, version };
				await send(successResponse(request.requestId, { version }));
				return;
			}
			case "planning/validate":
				this.planningValidationCalls += 1;
				await send(
					successResponse(request.requestId, {
						ok: !this.options.planningConflictScenario,
						issues: this.options.planningConflictScenario
							? this.planningValidationCalls === 1
								? [
										{
											code: "stale-calendar-revision",
											message: "日历版本已变化。",
										},
									]
								: [
										{
											code: "calendar-conflict",
											message: "修复后的排程仍有冲突。",
											proposalId: "proposal-1",
											busyEventIds: ["busy-1"],
										},
									]
							: [],
						calendar: {
							revision: this.options.planningConflictScenario ? 8 : 7,
							fromDate: "2099-01-01",
							toDateExclusive: "2100-01-01",
							timeZone: "Asia/Shanghai",
							events: [],
						},
					}),
				);
				return;
			case "tool/propose":
				await send(
					successResponse(request.requestId, {
						approvalId: "approval-1",
						toolCallId: request.params.toolCallId,
						title: "新建日程",
						description: "在日历中新建“核心工作”。",
						risk: "write",
						inputDigest: "digest-1",
						requestedAtMs: 1,
						expiresAtMs: 600_001,
						runVersion: 41,
					}),
				);
				return;
			case "tool/call":
				this.lastToolCall = structuredClone(request.params);
				await send(successResponse(request.requestId, { eventId: "event-1" }));
				return;
			case "tool/cancel":
				await send(successResponse(request.requestId, { cancelled: true }));
				return;
			case "model/relay.abort":
				await send(successResponse(request.requestId, { aborted: true }));
				return;
			case "model/relay.open":
				await this.openModelRelay(request, send);
				return;
			default:
				throw new Error(`Unexpected host call ${request.method}`);
		}
	}

	private handleWorkflowSnapshot(
		method: string,
		params: Record<string, unknown>,
	): unknown {
		this.workflowSnapshotCalls.push({
			method,
			params: structuredClone(params),
		});
		const workflowName =
			typeof params.workflowName === "string" ? params.workflowName : undefined;
		const runId = typeof params.runId === "string" ? params.runId : undefined;
		if (method === "workflow/snapshot.list") {
			const runs = [...this.workflowSnapshots.values()].filter(
				(record) => !workflowName || record.workflowName === workflowName,
			);
			return { runs: structuredClone(runs), total: runs.length };
		}
		if (method === "workflow/snapshot.get") {
			const record =
				workflowName && runId
					? this.workflowSnapshots.get(workflowSnapshotKey(workflowName, runId))
					: [...this.workflowSnapshots.values()].find(
							(candidate) => candidate.runId === runId,
						);
			return record ? structuredClone(record) : null;
		}
		if (!workflowName || !runId) {
			throw new Error(`Invalid Workflow snapshot request ${method}`);
		}
		const key = workflowSnapshotKey(workflowName, runId);
		if (method === "workflow/snapshot.persist") {
			if (!isRecord(params.snapshot)) {
				throw new Error("Invalid Workflow snapshot payload");
			}
			const existing = this.workflowSnapshots.get(key);
			const now = Date.now();
			this.workflowSnapshots.set(key, {
				workflowName,
				runId,
				...(typeof params.resourceId === "string"
					? { resourceId: params.resourceId }
					: {}),
				snapshot: structuredClone(params.snapshot),
				createdAtMs:
					typeof params.createdAtMs === "number"
						? params.createdAtMs
						: (existing?.createdAtMs ?? now),
				updatedAtMs:
					typeof params.updatedAtMs === "number" ? params.updatedAtMs : now,
			});
			return { persisted: true };
		}
		const record = this.workflowSnapshots.get(key);
		if (method === "workflow/snapshot.load") {
			return record ? structuredClone(record.snapshot) : null;
		}
		if (method === "workflow/snapshot.delete") {
			return { deleted: this.workflowSnapshots.delete(key) };
		}
		if (!record)
			return method === "workflow/snapshot.update-results" ? {} : null;
		if (method === "workflow/snapshot.update-state") {
			if (!isRecord(params.opts))
				throw new Error("Invalid Workflow state update");
			record.snapshot = {
				...record.snapshot,
				...structuredClone(params.opts),
			};
			record.updatedAtMs = Date.now();
			return structuredClone(record.snapshot);
		}
		if (method === "workflow/snapshot.update-results") {
			if (
				typeof params.stepId !== "string" ||
				!isRecord(params.result) ||
				!isRecord(params.requestContext)
			) {
				throw new Error("Invalid Workflow result update");
			}
			const context = mergeFakeWorkflowStepResult(
				record.snapshot,
				params.stepId,
				params.result,
				params.requestContext,
			);
			record.updatedAtMs = Date.now();
			return context;
		}
		throw new Error(`Unexpected Workflow snapshot method ${method}`);
	}

	private async openModelRelay(
		request: Extract<SidecarHostRequest, { method: "model/relay.open" }>,
		send: (message: ProtocolMessage) => Promise<void>,
	): Promise<void> {
		const params = request.params as ModelRelayOpenParams;
		this.modelOrigins.push(params.originatingRequestId);
		const body = JSON.parse(
			Buffer.from(params.request.bodyBase64 ?? "", "base64").toString("utf8"),
		) as Record<string, unknown>;
		this.modelBodies.push(body);
		if (params.provider === "whalehall-activity-reflection") {
			const content = JSON.stringify({
				events: [
					{
						action: this.options.reflectionSensorOnlyAction
							? "推测：应用状态更改"
							: "推测：正在进行编程",
						activity: "development",
						goal_relevance: "direct",
						confidence: 0.7,
						reason_codes: ["fixture"],
						evidence: ["测试证据"],
						signal_segment_ids: ["segment-1"],
						started_at_ms: null,
						ended_at_ms: null,
					},
				],
				score: 0.7,
				score_reason: "目标直接相关，强交叉证据，持续约 1 分钟，计 0.70 分",
			});
			await send(
				successResponse(request.requestId, {
					relayId: params.relayId,
					status: 200,
					headers: { "content-type": "application/json" },
					completed: true,
					bodyBase64: Buffer.from(
						JSON.stringify({
							id: "chatcmpl-reflection",
							object: "chat.completion",
							created: 1,
							model: params.modelId,
							choices: [
								{
									index: 0,
									message: { role: "assistant", content },
									finish_reason: "stop",
								},
							],
						}),
					).toString("base64"),
				}),
			);
			return;
		}
		await send(
			successResponse(request.requestId, {
				relayId: params.relayId,
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		if (this.options.holdModelOpen) return;
		if (
			this.options.activityToolViolation &&
			params.runId === "activity-run-tool-violation"
		) {
			await this.streamRelay(
				request,
				params,
				openAiToolCallSse(
					"forbidden-activity-tool-call",
					"calendar_create_event",
					{},
				),
				send,
			);
			return;
		}

		const structured = body.response_format !== undefined;
		if (
			(this.options.toolApprovalScenario || this.options.readToolScenario) &&
			!structured
		) {
			this.toolModelCalls += 1;
			const sse =
				this.toolModelCalls === 1
					? this.options.readToolScenario
						? openAiToolCallSse(
								"read-tool-call-1",
								"planning_get_active_goal",
								{},
							)
						: openAiToolCallSse(
								"tool-call-1",
								"calendar_create_event",
								{
									title: "核心工作",
									event: {
										title: "核心工作",
										start: "2099-12-01T09:00:00+08:00",
										end: "2099-12-01T10:00:00+08:00",
										timeZone: "Asia/Shanghai",
									},
								},
								"我来处理。",
							)
					: openAiSse(
							this.options.readToolScenario
								? "当前目标是完成 WhaleHall Beta。"
								: "日程已经按你的要求创建。",
						);
			await this.streamRelay(request, params, sse, send);
			return;
		}
		let content: string;
		if (structured) {
			this.planningModelCalls += 1;
			content = JSON.stringify(
				this.options.planningConflictScenario
					? planningDraftFixture(this.planningModelCalls === 1 ? 7 : 8)
					: this.planningModelCalls === 1
						? {
								status: "clarifying",
								questions: [
									{
										key: "expected_outcome",
										text: "你希望 Beta 达到什么验收结果？",
										required: true,
									},
								],
							}
						: planningDraftFixture(),
			);
		} else {
			content = "今天先完成最重要的一件事。";
		}
		await this.streamRelay(request, params, openAiSse(content), send);
	}

	private async streamRelay(
		request: Extract<SidecarHostRequest, { method: "model/relay.open" }>,
		params: ModelRelayOpenParams,
		sse: Uint8Array,
		send: (message: ProtocolMessage) => Promise<void>,
	): Promise<void> {
		let sequence = 0;
		for (let offset = 0; offset < sse.byteLength; offset += 61) {
			const chunk = sse.subarray(offset, Math.min(offset + 61, sse.byteLength));
			expect(chunk.byteLength).toBeLessThanOrEqual(MAX_MODEL_RELAY_CHUNK_BYTES);
			await send({
				protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
				type: "relay-event",
				requestId: request.requestId,
				relayId: params.relayId,
				sequence: ++sequence,
				emittedAtMs: Date.now(),
				event: {
					kind: "model/relay.chunk",
					bodyBase64: Buffer.from(chunk).toString("base64"),
				},
			});
		}
		await send({
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "relay-event",
			requestId: request.requestId,
			relayId: params.relayId,
			sequence: ++sequence,
			emittedAtMs: Date.now(),
			event: { kind: "model/relay.end" },
		});
	}
}

function openAiSse(content: string): Uint8Array {
	const chunks = [
		{
			id: "chatcmpl-test",
			created: 1,
			model: "test-chat-model",
			choices: [{ delta: { role: "assistant", content }, finish_reason: null }],
		},
		{
			id: "chatcmpl-test",
			created: 1,
			model: "test-chat-model",
			choices: [{ delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
		},
	];
	return new TextEncoder().encode(
		`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
	);
}

function openAiToolCallSse(
	toolCallId: string,
	toolName: string,
	argumentsValue: Record<string, unknown>,
	preamble = "",
): Uint8Array {
	const chunks = [
		{
			id: "chatcmpl-tool-test",
			created: 1,
			model: "test-chat-model",
			choices: [
				{
					delta: {
						role: "assistant",
						...(preamble ? { content: preamble } : {}),
						tool_calls: [
							{
								index: 0,
								id: toolCallId,
								type: "function",
								function: {
									name: toolName,
									arguments: JSON.stringify(argumentsValue),
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: "chatcmpl-tool-test",
			created: 1,
			model: "test-chat-model",
			choices: [{ delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
		},
	];
	return new TextEncoder().encode(
		`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
	);
}

function planningInputFixture() {
	return {
		goal: "在年底前完成 WhaleHall Beta",
		planType: "long-term",
		deadline: "2099-12-31",
		priority: "high",
		weeklyCapacityHours: 10,
		unavailableDays: ["Sunday"],
		preferredSessionMinutes: 60,
		preferredDayPart: "morning",
		timeZone: "Asia/Shanghai",
	};
}

function planningDraftFixture(calendarRevision = 7) {
	return {
		status: "draft",
		draft: {
			id: "draft-1",
			title: "WhaleHall Beta 计划",
			assumptions: [],
			calendarRevision,
			phases: [
				{
					id: "phase-1",
					title: "核心阶段",
					objective: "完成核心能力",
					order: 1,
				},
			],
			milestones: [
				{
					id: "milestone-1",
					phaseId: "phase-1",
					title: "核心验收",
					description: "完成核心能力",
					targetDate: "2099-12-31",
					acceptanceCriteria: ["核心测试通过"],
				},
			],
			tasks: [
				{
					id: "task-1",
					milestoneId: "milestone-1",
					title: "完成核心测试",
					description: "修复并运行测试",
					estimatedMinutes: 60,
					importance: "high",
					dependencies: [],
					completionCriteria: ["测试通过"],
				},
			],
			schedule: [
				{
					id: "proposal-1",
					taskId: "task-1",
					title: "完成核心测试",
					start: "2099-12-01T09:00:00+08:00",
					end: "2099-12-01T10:00:00+08:00",
					timeZone: "Asia/Shanghai",
				},
			],
			unscheduledTaskIds: [],
		},
	};
}

function workflowSnapshotKey(workflowName: string, runId: string): string {
	return `${workflowName}\0${runId}`;
}

function mergeFakeWorkflowStepResult(
	snapshot: Record<string, unknown>,
	stepId: string,
	result: Record<string, unknown>,
	requestContext: Record<string, unknown>,
): Record<string, unknown> {
	if (!isRecord(snapshot.context)) {
		throw new Error("Invalid stored Workflow context");
	}
	const context = snapshot.context;
	const existing = context[stepId];
	if (
		isRecord(existing) &&
		Array.isArray(existing.output) &&
		Array.isArray(result.output)
	) {
		const incomingOutput = result.output;
		const mergedOutput = [...existing.output];
		const hasPending = incomingOutput.some(isPendingWorkflowMarker);
		const size = Math.max(existing.output.length, incomingOutput.length);
		for (let index = 0; index < size; index += 1) {
			if (index >= incomingOutput.length) continue;
			const incoming = incomingOutput[index];
			if (isPendingWorkflowMarker(incoming)) {
				if (
					index >= existing.output.length ||
					canResetWorkflowOutput(existing.output[index])
				) {
					mergedOutput[index] = null;
				}
			} else if (incoming !== null && incoming !== undefined && !hasPending) {
				mergedOutput[index] = structuredClone(incoming);
			} else if (index >= existing.output.length) {
				mergedOutput[index] = null;
			}
		}
		context[stepId] = {
			...structuredClone(existing),
			...(hasPending ? {} : structuredClone(result)),
			output: mergedOutput,
		};
	} else {
		context[stepId] = structuredClone(result);
	}
	snapshot.requestContext = {
		...(isRecord(snapshot.requestContext) ? snapshot.requestContext : {}),
		...structuredClone(requestContext),
	};
	return structuredClone(context);
}

function isPendingWorkflowMarker(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.__mastra_pending__ === true &&
		Object.keys(value).length === 1
	);
}

function canResetWorkflowOutput(value: unknown): boolean {
	if (value === null || value === undefined || isPendingWorkflowMarker(value))
		return true;
	return (
		isRecord(value) &&
		value.status === "suspended" &&
		("suspendPayload" in value || "suspendedAt" in value)
	);
}

function isSidecarRequest(value: unknown): value is SidecarHostRequest {
	return (
		isRecord(value) &&
		value.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
		value.type === "request" &&
		typeof value.requestId === "string" &&
		typeof value.method === "string" &&
		(SIDECAR_HOST_METHODS as readonly string[]).includes(value.method) &&
		isRecord(value.params)
	);
}

function isRunEvent(value: unknown): value is AgentRunEventFrame {
	return (
		isRecord(value) &&
		value.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
		value.type === "event" &&
		typeof value.runId === "string" &&
		typeof value.sequence === "number" &&
		typeof value.version === "number" &&
		isRecord(value.event)
	);
}
