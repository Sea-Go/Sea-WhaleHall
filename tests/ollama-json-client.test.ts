import { describe, expect, test } from "bun:test";
import {
	OllamaClientError,
	OllamaJsonClient,
	OllamaSchemaError,
} from "../src/agent/model/ollama-json-client";

type Label = { label: "development" };

const schema = {
	type: "object",
	properties: { label: { const: "development" } },
	required: ["label"],
	additionalProperties: false,
};

function isLabel(value: unknown): value is Label {
	return (
		typeof value === "object" &&
		value !== null &&
		"label" in value &&
		value.label === "development"
	);
}

describe("OllamaJsonClient", () => {
	test("uses qwen3:4b structured output with fixed local runtime settings", async () => {
		let body: Record<string, unknown> | null = null;
		const client = new OllamaJsonClient({
			fetch: (async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return Response.json({
					message: { content: '{"label":"development"}' },
				});
			}),
		});
		await expect(
			client.generateJson({
				messages: [{ role: "user", content: "label this" }],
				schema,
				validate: isLabel,
				maxOutputTokens: 96,
			}),
		).resolves.toEqual({ label: "development" });
		expect(body).toMatchObject({
			model: "qwen3:4b",
			stream: false,
			think: false,
			format: schema,
			keep_alive: "30m",
			options: {
				num_ctx: 4096,
				temperature: 0,
				num_predict: 96,
			},
		});
	});

	test("retries malformed structured output exactly once", async () => {
		let calls = 0;
		const client = new OllamaJsonClient({
			fetch: (async () => {
				calls += 1;
				return Response.json({
					message: {
						content:
							calls === 1 ? "not-json" : '{"label":"development"}',
					},
				});
			}),
		});
		await expect(
			client.generateJson({
				messages: [{ role: "user", content: "label this" }],
				schema,
				validate: isLabel,
			}),
		).resolves.toEqual({ label: "development" });
		expect(calls).toBe(2);
	});

	test("prioritizes realtime work ahead of queued batch work", async () => {
		const order: string[] = [];
		let releaseFirst: () => void = () => {};
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const client = new OllamaJsonClient({
			fetch: (async (_input, init) => {
				calls += 1;
				const parsed = JSON.parse(String(init?.body)) as {
					messages: Array<{ content: string }>;
				};
				const name = parsed.messages[0]?.content ?? "unknown";
				order.push(name);
				if (calls === 1) await firstBlocked;
				return Response.json({
					message: { content: '{"label":"development"}' },
				});
			}),
		});
		const first = client.generateJson({
			messages: [{ role: "user", content: "batch-1" }],
			schema,
			validate: isLabel,
			priority: "batch",
		});
		const second = client.generateJson({
			messages: [{ role: "user", content: "batch-2" }],
			schema,
			validate: isLabel,
			priority: "batch",
		});
		const realtime = client.generateJson({
			messages: [{ role: "user", content: "realtime" }],
			schema,
			validate: isLabel,
			priority: "realtime",
		});
		releaseFirst();
		await Promise.all([first, second, realtime]);
		expect(order).toEqual(["batch-1", "realtime", "batch-2"]);
	});

	test("rejects non-loopback endpoints", () => {
		expect(
			() => new OllamaJsonClient({ baseUrl: "https://example.com" }),
		).toThrow("loopback");
	});

	test("fails after the single schema retry", async () => {
		const client = new OllamaJsonClient({
			fetch: (async () =>
				Response.json({ message: { content: "{}" } })),
		});
		await expect(
			client.generateJson({
				messages: [{ role: "user", content: "label this" }],
				schema,
				validate: isLabel,
			}),
		).rejects.toBeInstanceOf(OllamaSchemaError);
	});

	test("returns typed diagnostics without leaking transport or generated content", async () => {
		const transportSecret = "private prompt copied into transport failure";
		const transportClient = new OllamaJsonClient({
			fetch: async () => {
				throw new Error(transportSecret);
			},
		});
		let transportError: unknown;
		try {
			await transportClient.generateJson({
				messages: [
					{ role: "user", content: "sensitive user prompt" },
				],
				schema,
				validate: isLabel,
			});
		} catch (error) {
			transportError = error;
		}
		expect(transportError).toBeInstanceOf(OllamaClientError);
		expect((transportError as OllamaClientError).code).toBe(
			"transport_error",
		);
		expect((transportError as Error).message).toBe(
			"Ollama request failed.",
		);
		expect(
			JSON.stringify(
				(transportError as OllamaClientError).toDiagnostic(),
			),
		).not.toContain(transportSecret);

		const generatedSecret = "private generated response";
		const schemaClient = new OllamaJsonClient({
			fetch: async () =>
				Response.json({
					message: { content: generatedSecret },
				}),
		});
		let schemaError: unknown;
		try {
			await schemaClient.generateJson({
				messages: [
					{ role: "user", content: "another sensitive prompt" },
				],
				schema,
				validate: isLabel,
			});
		} catch (error) {
			schemaError = error;
		}
		expect(schemaError).toBeInstanceOf(OllamaSchemaError);
		expect((schemaError as OllamaClientError).code).toBe("invalid_json");
		expect((schemaError as Error).message).not.toContain(generatedSecret);
		expect(
			JSON.stringify(
				(schemaError as OllamaClientError).toDiagnostic(),
			),
		).not.toContain(generatedSecret);
	});
});
