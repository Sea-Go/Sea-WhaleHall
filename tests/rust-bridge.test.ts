import { describe, expect, test } from "bun:test";
import {
	RustBridge,
	RustBridgeError,
	type ChildTransport,
} from "../src/bun/agent/rust-bridge";

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
				this.onWrite(typeof value === "string" ? value : new TextDecoder().decode(value), this);
				return typeof value === "string" ? value.length : value.byteLength;
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

	emitRaw(value: string): void {
		this.stdoutController.enqueue(new TextEncoder().encode(value));
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

describe("RustBridge", () => {
	test("correlates a successful response", async () => {
		const child = new FakeChild((line, process) => {
			const request = JSON.parse(line) as { id: string; params: { message: string } };
			process.respond({
				id: request.id,
				ok: true,
				result: { message: request.params.message },
			});
		});
		const bridge = new RustBridge("fake", { spawn: () => child });
		await bridge.start();
		await expect(bridge.request("echo", { message: "hello" })).resolves.toEqual({
			message: "hello",
		});
		bridge.stop();
	});

	test("times out a request without an automatic restart loop", async () => {
		const child = new FakeChild();
		const bridge = new RustBridge("fake", { spawn: () => child, timeoutMs: 10 });
		await bridge.start();
		await expect(bridge.request("health.check", {})).rejects.toMatchObject({
			code: "REQUEST_TIMEOUT",
		});
		expect(bridge.isRunning).toBe(true);
		bridge.stop();
	});

	test("rejects pending requests when the process exits", async () => {
		const child = new FakeChild();
		const bridge = new RustBridge("fake", { spawn: () => child, timeoutMs: 1000 });
		await bridge.start();
		const request = bridge.request("health.check", {});
		child.exit(9);
		await expect(request).rejects.toMatchObject({ code: "PROCESS_EXITED" });
		expect(bridge.isRunning).toBe(false);
	});

	test("kills the child and rejects work on malformed stdout", async () => {
		const child = new FakeChild();
		const bridge = new RustBridge("fake", { spawn: () => child, timeoutMs: 1000 });
		await bridge.start();
		const request = bridge.request("health.check", {});
		child.emitRaw("not-json\n");
		await expect(request).rejects.toBeInstanceOf(RustBridgeError);
		expect(bridge.isRunning).toBe(false);
	});
});
