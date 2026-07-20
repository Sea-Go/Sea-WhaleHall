import { describe, expect, test } from "bun:test";
import {
	JsonlParser,
	JsonlProtocolError,
	LocalClientError,
	LocalToolClient,
	type ChildTransport,
} from "../src/agent/local-tool-client";
import type { LocalToolDescriptor } from "../src/agent/local-protocol";

class FakeChild implements ChildTransport {
	pid = 4242;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	stdin: ChildTransport["stdin"];
	private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	private stderrController!: ReadableStreamDefaultController<Uint8Array>;
	private resolveExit!: (code: number) => void;
	private closed = false;

	constructor(private readonly onWrite: (value: string, child: FakeChild) => void = () => {}) {
		this.stdout = new ReadableStream({
			start: (controller) => {
				this.stdoutController = controller;
			},
		});
		this.stderr = new ReadableStream({
			start: (controller) => {
				this.stderrController = controller;
			},
		});
		this.exited = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		this.stdin = {
			write: (value) => {
				const text = typeof value === "string" ? value : new TextDecoder().decode(value);
				for (const line of text.trim().split("\n")) this.onWrite(line, this);
				return text.length;
			},
			flush: () => 0,
			end: () => {
				this.exit(0);
				return 0;
			},
		};
	}

	respond(value: unknown): void {
		this.stdoutController.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
	}

	emitChunks(...values: string[]): void {
		for (const value of values) this.stdoutController.enqueue(new TextEncoder().encode(value));
	}

	exit(code: number): void {
		if (this.closed) return;
		this.closed = true;
		this.stdoutController.close();
		this.stderrController.close();
		this.resolveExit(code);
	}

	kill(): void {
		this.exit(143);
	}
}

const descriptor: LocalToolDescriptor = {
	name: "system.info",
	description: "system",
	inputSchema: { type: "object" },
	risk: "read",
	requiredPermissions: [],
	supportsCancellation: false,
};

describe("JsonlParser", () => {
	const encoder = new TextEncoder();

	test("reassembles fragments and emits multiple lines", () => {
		const lines: string[] = [];
		const parser = new JsonlParser((line) => lines.push(line), 1024);
		parser.feed(encoder.encode('{"id":"1"'));
		parser.feed(encoder.encode('}\n{"id":"2"}\r\n'));
		expect(lines).toEqual(['{"id":"1"}', '{"id":"2"}']);
	});

	test("rejects an oversized line", () => {
		const parser = new JsonlParser(() => {}, 4);
		expect(() => parser.feed(encoder.encode("12345"))).toThrow(JsonlProtocolError);
	});
});

describe("LocalToolClient", () => {
	test("correlates responses and routes streamed events", async () => {
		const child = new FakeChild((line, process) => {
			const request = JSON.parse(line) as { id: string; method: string };
			if (request.method === "runtime.health") {
				process.respond({
					id: request.id,
					ok: true,
					result: { service: "whalehall-local", version: "0.1.0", pid: 4242, status: "ok" },
				});
			} else if (request.method === "tool.list") {
				process.respond({ id: request.id, ok: true, result: { tools: [descriptor] } });
			} else if (request.method === "tool.call") {
				const event = JSON.stringify({
					event: "tool.progress",
					callId: request.id,
					data: { progress: 50, message: "half" },
				});
				const response = JSON.stringify({
					id: request.id,
					ok: true,
					result: { callId: request.id, output: { os: "macos" } },
				});
				process.emitChunks(`${event.slice(0, 20)}`, `${event.slice(20)}\n${response}\n`);
			}
		});
		const client = new LocalToolClient("fake", { spawn: () => child });
		const events: string[] = [];
		client.onEvent((event) => events.push(event.event));
		await client.start();
		await expect(client.health()).resolves.toMatchObject({ status: "ok" });
		await expect(client.listTools()).resolves.toEqual([descriptor]);
		await expect(
			client.callTool({ callId: "call-1", name: "system.info", arguments: {} }),
		).resolves.toEqual({ callId: "call-1", output: { os: "macos" } });
		expect(events).toEqual(["tool.progress"]);
		client.stop();
	});

	test("times out a tool call and sends a best-effort cancellation", async () => {
		const methods: string[] = [];
		const child = new FakeChild((line) => {
			methods.push((JSON.parse(line) as { method: string }).method);
		});
		const client = new LocalToolClient("fake", {
			spawn: () => child,
			toolTimeoutMs: 10,
		});
		await client.start();
		await expect(
			client.callTool({ callId: "slow", name: "demo.wait", arguments: { durationMs: 5000 } }),
		).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
		expect(methods).toEqual(["tool.call", "tool.cancel"]);
		expect(client.isRunning).toBe(true);
		client.stop();
	});

	test("rejects pending requests when the process exits", async () => {
		const child = new FakeChild();
		const client = new LocalToolClient("fake", { spawn: () => child });
		await client.start();
		const request = client.listTools();
		child.exit(9);
		await expect(request).rejects.toMatchObject({ code: "PROCESS_EXITED" });
		expect(client.isRunning).toBe(false);
	});

	test("kills the child on malformed stdout", async () => {
		const child = new FakeChild();
		const client = new LocalToolClient("fake", { spawn: () => child });
		await client.start();
		const request = client.listTools();
		child.emitChunks("not-json\n");
		await expect(request).rejects.toBeInstanceOf(LocalClientError);
		expect(client.isRunning).toBe(false);
	});
});
