import {
	MAX_JSONL_LINE_BYTES,
	RUST_REQUEST_TIMEOUT_MS,
	parseRustResponse,
	type RustMethod,
	type RustRequest,
} from "../../shared/protocol";
import { JsonlParser } from "./jsonl-parser";

export type RustBridgeFailureCode =
	| "SPAWN_FAILED"
	| "PROCESS_EXITED"
	| "PROTOCOL_ERROR"
	| "REQUEST_TIMEOUT"
	| "STOPPED"
	| "WRITE_FAILED";

export class RustBridgeError extends Error {
	constructor(
		public readonly code: RustBridgeFailureCode | string,
		message: string,
	) {
		super(message);
		this.name = "RustBridgeError";
	}
}

export type ChildTransport = {
	pid: number;
	stdin: {
		write(data: string | Uint8Array): number;
		flush(): number | Promise<number>;
		end(error?: Error): number | Promise<number>;
	};
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
};

export type SpawnChild = (binaryPath: string) => ChildTransport;

export interface AgentBridge {
	readonly pid: number | null;
	readonly isRunning: boolean;
	start(): Promise<void>;
	request<T>(method: RustMethod, params: Record<string, unknown>): Promise<T>;
	stop(): void;
	onFailure(listener: (error: RustBridgeError) => void): () => void;
}

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

function spawnRust(binaryPath: string): ChildTransport {
	return Bun.spawn({
		cmd: [binaryPath],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	}) as unknown as ChildTransport;
}

export class RustBridge implements AgentBridge {
	private child: ChildTransport | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly failureListeners = new Set<(error: RustBridgeError) => void>();
	private stopping = false;

	constructor(
		private readonly binaryPath: string,
		private readonly options: {
			spawn?: SpawnChild;
			timeoutMs?: number;
			maxLineBytes?: number;
		} = {},
	) {}

	get pid(): number | null {
		return this.child?.pid ?? null;
	}

	get isRunning(): boolean {
		return this.child !== null;
	}

	async start(): Promise<void> {
		if (this.child) return;
		this.stopping = false;

		let child: ChildTransport;
		try {
			child = (this.options.spawn ?? spawnRust)(this.binaryPath);
		} catch (error) {
			const bridgeError = new RustBridgeError(
				"SPAWN_FAILED",
				`Unable to start Rust child: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.emitFailure(bridgeError);
			throw bridgeError;
		}

		this.child = child;
		void this.readStdout(child);
		void this.readStderr(child);
		void child.exited.then((exitCode) => this.handleExit(child, exitCode));
	}

	request<T>(method: RustMethod, params: Record<string, unknown>): Promise<T> {
		const child = this.child;
		if (!child) {
			return Promise.reject(new RustBridgeError("SPAWN_FAILED", "Rust child is not running."));
		}

		const id = crypto.randomUUID();
		const request: RustRequest = { id, method, params };
		const timeoutMs = this.options.timeoutMs ?? RUST_REQUEST_TIMEOUT_MS;

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				const error = new RustBridgeError(
					"REQUEST_TIMEOUT",
					`Rust request '${method}' timed out after ${timeoutMs} ms.`,
				);
				this.emitFailure(error);
				reject(error);
			}, timeoutMs);

			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timeout,
			});

			try {
				child.stdin.write(`${JSON.stringify(request)}\n`);
				void child.stdin.flush();
			} catch (error) {
				clearTimeout(timeout);
				this.pending.delete(id);
				const bridgeError = new RustBridgeError(
					"WRITE_FAILED",
					`Failed writing to Rust child: ${error instanceof Error ? error.message : String(error)}`,
				);
				reject(bridgeError);
				this.failChild(child, bridgeError, true);
			}
		});
	}

	stop(): void {
		this.stopping = true;
		const child = this.child;
		this.child = null;
		this.rejectPending(new RustBridgeError("STOPPED", "Rust child was stopped."));
		if (child) {
			try {
				void child.stdin.end();
			} catch {}
			try {
				child.kill();
			} catch {}
		}
	}

	onFailure(listener: (error: RustBridgeError) => void): () => void {
		this.failureListeners.add(listener);
		return () => this.failureListeners.delete(listener);
	}

	private async readStdout(child: ChildTransport): Promise<void> {
		const parser = new JsonlParser(
			(line) => this.handleLine(child, line),
			this.options.maxLineBytes ?? MAX_JSONL_LINE_BYTES,
		);
		const reader = child.stdout.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				parser.feed(value);
			}
			parser.finish();
		} catch (error) {
			const bridgeError = new RustBridgeError(
				"PROTOCOL_ERROR",
				`Rust stdout protocol failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.failChild(child, bridgeError, true);
		} finally {
			reader.releaseLock();
		}
	}

	private async readStderr(child: ChildTransport): Promise<void> {
		const reader = child.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true }).trimEnd();
				if (text) console.error(`[whalehall-core:${child.pid}] ${text}`);
			}
		} catch (error) {
			console.error("Failed reading Rust stderr:", error);
		} finally {
			reader.releaseLock();
		}
	}

	private handleLine(child: ChildTransport, line: string): void {
		if (child !== this.child) return;
		const response = parseRustResponse(line);
		const responseId = response.id;
		if (responseId === null) {
			if (response.ok) throw new Error("Successful Rust response had no request ID.");
			throw new Error(`${response.error.code}: ${response.error.message}`);
		}

		const pending = this.pending.get(responseId);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pending.delete(responseId);
		if (response.ok) {
			pending.resolve(response.result);
		} else {
			pending.reject(new RustBridgeError(response.error.code, response.error.message));
		}
	}

	private handleExit(child: ChildTransport, exitCode: number): void {
		if (child !== this.child) return;
		this.child = null;
		if (this.stopping) return;
		const error = new RustBridgeError(
			"PROCESS_EXITED",
			`Rust child exited unexpectedly with code ${exitCode}.`,
		);
		this.rejectPending(error);
		this.emitFailure(error);
	}

	private failChild(child: ChildTransport, error: RustBridgeError, kill: boolean): void {
		if (child !== this.child) return;
		this.child = null;
		this.rejectPending(error);
		this.emitFailure(error);
		if (kill) {
			try {
				child.kill();
			} catch {}
		}
	}

	private rejectPending(error: RustBridgeError): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timeout);
			request.reject(error);
		}
		this.pending.clear();
	}

	private emitFailure(error: RustBridgeError): void {
		for (const listener of this.failureListeners) listener(error);
	}
}
