import { describe, expect, test } from "bun:test";
import {
	ActivityEventWorkerClient,
	type ActivityEventWorkerRequest,
	type ActivityEventWorkerResponse,
} from "../src/agent/activity-event-worker";

function workerResponse(
	requestId: string,
	sourceEventId: string,
	score: number,
): ActivityEventWorkerResponse {
	return {
		schema_version: "activity-event-analysis-response.v1",
		request_id: requestId,
		events: [
			{
				source_event_ids: [sourceEventId],
				activity: "development",
				goal_relevance: "direct",
				confidence: 0.9,
				reason_codes: ["visible_content"],
				evidence: ["Editor is active"],
				started_at_ms: 1_000,
				ended_at_ms: 1_001,
			},
		],
		score,
		score_reason: "Goal progress",
	};
}

describe("ActivityEventWorkerClient", () => {
	test("sends the complete raw JSON payload with its dedicated bearer token", async () => {
		const capture: {
			received: ActivityEventWorkerRequest | null;
			authorization: string | null;
		} = { received: null, authorization: null };
		const client = new ActivityEventWorkerClient({
			endpoint: "https://worker.example.test/v1/activity/analyze",
			authorizationToken: "dedicated-token",
			fetch: async (_input, init) => {
				if (typeof init?.body !== "string") throw new Error("Expected JSON body.");
				capture.received = JSON.parse(init.body) as ActivityEventWorkerRequest;
				capture.authorization = new Headers(init.headers).get("authorization");
				return new Response(
					JSON.stringify(workerResponse("request-1", "raw-1", 0.5)),
					{ status: 200 },
				);
			},
		});

		const response = await client.analyze({
			schema_version: "activity-event-analysis-request.v1",
			request_id: "request-1",
			raw_event: {
				observationId: "raw-1",
				metadata: { appId: "com.example.Editor", allFieldsRetained: true },
			},
			context: { goal: { goalId: "goal-1" } },
		});

		if (capture.received === null) throw new Error("Worker request was not captured.");
		expect(capture.received.raw_event).toEqual({
			observationId: "raw-1",
			metadata: { appId: "com.example.Editor", allFieldsRetained: true },
		});
		expect(capture.received.context).toEqual({ goal: { goalId: "goal-1" } });
		expect(capture.authorization).toBe("Bearer dedicated-token");
		expect(response.score).toBe(0.5);
	});

	test("reports only safe aggregate diagnostics when a gateway rejects a request", async () => {
		const client = new ActivityEventWorkerClient({
			endpoint: "https://worker.example.test/v1/activity/analyze",
			authorizationToken: "dedicated-token",
			fetch: async () =>
				new Response("upstream unavailable", {
					status: 502,
					headers: { server: "Caddy" },
				}),
		});

		await expect(
			client.analyze({
				schema_version: "activity-event-analysis-request.v1",
				request_id: "request-502",
				raw_event: { eventId: "raw-502", title: "not emitted in diagnostics" },
				context: {},
			}),
		).rejects.toMatchObject({
			code: "http_error",
			httpStatus: 502,
			requestBytes: expect.any(Number),
			responseServer: "Caddy",
		});
	});

	test("accepts an empty score reason when the cloud response otherwise matches its schema", async () => {
		const client = new ActivityEventWorkerClient({
			endpoint: "https://worker.example.test/v1/activity/analyze",
			authorizationToken: "dedicated-token",
			fetch: async () => {
				const response = workerResponse("request-empty-reason", "raw-empty", 0.5);
				response.score_reason = "";
				return new Response(JSON.stringify(response), { status: 200 });
			},
		});

		await expect(
			client.analyze({
				schema_version: "activity-event-analysis-request.v1",
				request_id: "request-empty-reason",
				raw_event: { eventId: "raw-empty" },
				context: {},
			}),
		).resolves.toMatchObject({ score_reason: "", score: 0.5 });
	});
});
