import {
	LOCAL_CONTROL_TIMEOUT_MS,
	LOCAL_TOOL_TIMEOUT_MS,
	MAX_JSONL_LINE_BYTES,
	isDesktopEvent,
	isLocalToolDescriptor,
	isRecord,
	parseLocalMessage,
	type LocalDesktopEventFrame,
	type LocalEventCommitResult,
	type LocalEventGoalChange,
	type LocalEventGoalChangeResult,
	type LocalEventQuery,
	type LocalEventQueryResult,
	type LocalMessage,
	type LocalMethod,
	type LocalRequest,
	type LocalRuntimeHealth,
	type LocalToolCall,
	type LocalToolCallResult,
	type LocalToolCancelResult,
	type LocalToolDescriptor,
	type LocalToolEvent,
	type LocalToolListResult,
} from "./local-protocol";

export type LocalClientFailureCode =
	| "SPAWN_FAILED"
	| "PROCESS_EXITED"
	| "PROTOCOL_ERROR"
	| "REQUEST_TIMEOUT"
	| "STOPPED"
	| "WRITE_FAILED";

export class LocalClientError extends Error {
	constructor(
		public readonly code: LocalClientFailureCode | string,
		message: string,
	) {
		super(message);
		this.name = "LocalClientError";
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

export type SpawnLocalProcess = (
	binaryPath: string,
	environment?: Readonly<Record<string, string>>,
) => ChildTransport;

export const STARTUP_GOAL_CHANGE_ENV =
	"WHALEHALL_STARTUP_GOAL_CHANGE_JSON";

export interface LocalToolProcess {
	readonly pid: number | null;
	readonly isRunning: boolean;
	prepareStartupGoalChange(change: LocalEventGoalChange | null): Promise<void>;
	acknowledgeStartupGoalChange(): Promise<void>;
	start(): Promise<void>;
	health(): Promise<LocalRuntimeHealth>;
	listTools(): Promise<LocalToolDescriptor[]>;
	callTool(call: LocalToolCall): Promise<LocalToolCallResult>;
	cancelTool(callId: string): Promise<LocalToolCancelResult>;
	queryEvents(query: LocalEventQuery): Promise<LocalEventQueryResult>;
	commitEventCursor(consumerId: string, cursor: string): Promise<LocalEventCommitResult>;
	appendGoalChange(change: LocalEventGoalChange): Promise<LocalEventGoalChangeResult>;
	stop(): Promise<void>;
	onEvent(listener: (event: LocalToolEvent) => void): () => void;
	onDesktopEvent(listener: (event: LocalDesktopEventFrame["data"]) => void): () => void;
	onFailure(listener: (error: LocalClientError) => void): () => void;
}

type PendingRequest = {
	method: LocalMethod;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

function spawnLocal(
	binaryPath: string,
	environment: Readonly<Record<string, string>> = {},
): ChildTransport {
	const inheritedEnvironment = { ...process.env };
	// The Rust sensor process never calls the model endpoint. Keep bearer
	// credentials in the Bun host that owns inference instead of widening
	// their process exposure.
	delete inheritedEnvironment.WHALEHALL_MODERNBERT_TOKEN;
	// This value is a one-shot control-plane handoff. Never inherit a stale
	// shell value into a sensor process; LocalToolClient adds only the payload
	// prepared for this exact spawn.
	delete inheritedEnvironment[STARTUP_GOAL_CHANGE_ENV];
	return Bun.spawn({
		cmd: [binaryPath],
		env: { ...inheritedEnvironment, ...environment },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	}) as unknown as ChildTransport;
}

export class LocalToolClient implements LocalToolProcess {
	private child: ChildTransport | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: LocalToolEvent) => void>();
	private readonly desktopEventListeners = new Set<
		(event: LocalDesktopEventFrame["data"]) => void
	>();
	private readonly failureListeners = new Set<(error: LocalClientError) => void>();
	private stopping = false;
	private preparedStartupGoalChange:
		| LocalEventGoalChange
		| null
		| undefined;
	private preparedStartupGoalChangeJson: string | null | undefined;

	constructor(
		private readonly binaryPath: string,
		private readonly options: {
			spawn?: SpawnLocalProcess;
			environment?: Readonly<Record<string, string>>;
			controlTimeoutMs?: number;
			toolTimeoutMs?: number;
			maxLineBytes?: number;
		} = {},
	) {}

	get pid(): number | null {
		return this.child?.pid ?? null;
	}

	get isRunning(): boolean {
		return this.child !== null;
	}

	async prepareStartupGoalChange(
		change: LocalEventGoalChange | null,
	): Promise<void> {
		if (this.child) {
			throw new LocalClientError(
				"INVALID_STATE",
				"Cannot prepare a startup goal boundary after whalehall-local has started.",
			);
		}
		if (change === null) {
			this.preparedStartupGoalChange = null;
			this.preparedStartupGoalChangeJson = null;
			return;
		}
		if (
			this.preparedStartupGoalChange !== null &&
			this.preparedStartupGoalChange !== undefined &&
			this.preparedStartupGoalChange.deduplicationKey ===
				change.deduplicationKey
		) {
			if (
				!sameGoalContext(
					this.preparedStartupGoalChange.previous,
					change.previous,
				) ||
				!sameGoalContext(
					this.preparedStartupGoalChange.next,
					change.next,
				)
			) {
				throw new LocalClientError(
					"INVALID_ARGUMENTS",
					"Startup goal deduplication key was reused for different goal contexts.",
				);
			}
			// A prior process may have appended this exact payload and crashed
			// before the reflection consumer materialized it. Preserve its
			// original occurredAtMs so native idempotency remains exact.
			return;
		}
		this.preparedStartupGoalChange = structuredClone(change);
		this.preparedStartupGoalChangeJson = JSON.stringify(change);
	}

	async acknowledgeStartupGoalChange(): Promise<void> {
		this.preparedStartupGoalChange = undefined;
		this.preparedStartupGoalChangeJson = undefined;
	}

	async start(): Promise<void> {
		if (this.child) return;
		this.stopping = false;
		const environment = { ...this.options.environment };
		delete environment[STARTUP_GOAL_CHANGE_ENV];
		if (
			this.preparedStartupGoalChangeJson !== null &&
			this.preparedStartupGoalChangeJson !== undefined
		) {
			environment[STARTUP_GOAL_CHANGE_ENV] =
				this.preparedStartupGoalChangeJson;
		}
		let child: ChildTransport;
		try {
			child = (this.options.spawn ?? spawnLocal)(
				this.binaryPath,
				environment,
			);
		} catch (error) {
			const clientError = new LocalClientError(
				"SPAWN_FAILED",
				`Unable to start whalehall-local: ${errorMessage(error)}`,
			);
			this.emitFailure(clientError);
			throw clientError;
		}
		this.child = child;
		void this.readStdout(child);
		void this.readStderr(child);
		void child.exited.then((exitCode) => this.handleExit(child, exitCode));
	}

	async health(): Promise<LocalRuntimeHealth> {
		const result = await this.request<unknown>("runtime.health", {});
		if (
			!isRecord(result) ||
			result.service !== "whalehall-local" ||
			typeof result.version !== "string" ||
			typeof result.pid !== "number" ||
			result.status !== "ok"
		) {
			throw this.protocolFailure("runtime.health returned an invalid payload.");
		}
		return result as LocalRuntimeHealth;
	}

	async listTools(): Promise<LocalToolDescriptor[]> {
		const result = await this.request<LocalToolListResult>("tool.list", {});
		if (!isRecord(result) || !Array.isArray(result.tools) || !result.tools.every(isLocalToolDescriptor)) {
			throw this.protocolFailure("tool.list returned an invalid tool catalog.");
		}
		return result.tools;
	}

	async callTool(call: LocalToolCall): Promise<LocalToolCallResult> {
		const result = await this.request<unknown>(
			"tool.call",
			{ name: call.name, arguments: call.arguments },
			call.callId,
			this.options.toolTimeoutMs ?? LOCAL_TOOL_TIMEOUT_MS,
		);
		if (!isRecord(result) || result.callId !== call.callId || !("output" in result)) {
			throw this.protocolFailure("tool.call returned an invalid result.");
		}
		return result as LocalToolCallResult;
	}

	async cancelTool(callId: string): Promise<LocalToolCancelResult> {
		const result = await this.request<unknown>("tool.cancel", { callId });
		if (
			!isRecord(result) ||
			result.callId !== callId ||
			typeof result.cancelled !== "boolean"
		) {
			throw this.protocolFailure("tool.cancel returned an invalid result.");
		}
		return result as LocalToolCancelResult;
	}

	async queryEvents(query: LocalEventQuery): Promise<LocalEventQueryResult> {
		if (query.afterCursor !== undefined && query.consumerId !== undefined) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"event.query accepts afterCursor or consumerId, not both.",
			);
		}
		const result = await this.request<unknown>("event.query", query);
		if (
			!isRecord(result) ||
			!Array.isArray(result.events) ||
			!result.events.every(isDesktopEvent) ||
			(result.nextCursor !== null && typeof result.nextCursor !== "string") ||
			typeof result.hasMore !== "boolean"
		) {
			throw this.protocolFailure("event.query returned an invalid result.");
		}
		return result as LocalEventQueryResult;
	}

	async commitEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult> {
		const result = await this.request<unknown>("event.commit", { consumerId, cursor });
		if (
			!isRecord(result) ||
			result.consumerId !== consumerId ||
			result.cursor !== cursor ||
			typeof result.advanced !== "boolean"
		) {
			throw this.protocolFailure("event.commit returned an invalid result.");
		}
		return result as LocalEventCommitResult;
	}

	async appendGoalChange(
		change: LocalEventGoalChange,
	): Promise<LocalEventGoalChangeResult> {
		const result = await this.request<unknown>("event.goal.change", change);
		if (
			!isRecord(result) ||
			typeof result.inserted !== "boolean" ||
			!isDesktopEvent(result.event) ||
			result.event.kind !== "goal.contextChanged" ||
			result.event.source !== "planning.controller" ||
			result.event.occurredAtMs !== change.occurredAtMs ||
			result.event.observedAtMs !== change.occurredAtMs ||
			result.event.goalVersion !== (change.previous?.version ?? null) ||
			result.event.sensitivity !== "content" ||
			!sameGoalContext(result.event.payload.previous, change.previous) ||
			!sameGoalContext(result.event.payload.next, change.next)
		) {
			throw this.protocolFailure("event.goal.change returned an invalid result.");
		}
		return result as LocalEventGoalChangeResult;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		const child = this.child;
		this.child = null;
		this.rejectPending(new LocalClientError("STOPPED", "whalehall-local was stopped."));
		if (!child) return;
		await closeGracefully(child);
	}

	onEvent(listener: (event: LocalToolEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onDesktopEvent(
		listener: (event: LocalDesktopEventFrame["data"]) => void,
	): () => void {
		this.desktopEventListeners.add(listener);
		return () => this.desktopEventListeners.delete(listener);
	}

	onFailure(listener: (error: LocalClientError) => void): () => void {
		this.failureListeners.add(listener);
		return () => this.failureListeners.delete(listener);
	}

	private request<T>(
		method: LocalMethod,
		params: Record<string, unknown>,
		id: string = crypto.randomUUID(),
		timeoutMs = this.options.controlTimeoutMs ?? LOCAL_CONTROL_TIMEOUT_MS,
	): Promise<T> {
		const child = this.child;
		if (!child) {
			return Promise.reject(
				new LocalClientError("SPAWN_FAILED", "whalehall-local is not running."),
			);
		}
		if (this.pending.has(id)) {
			return Promise.reject(
				new LocalClientError("PROTOCOL_ERROR", `Duplicate local request id: ${id}`),
			);
		}

		const request: LocalRequest = { id, method, params };
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				const error = new LocalClientError(
					"REQUEST_TIMEOUT",
					`Local request '${method}' timed out after ${timeoutMs} ms.`,
				);
				if (method === "tool.call") this.writeBestEffortCancel(child, id);
				this.emitFailure(error);
				reject(error);
			}, timeoutMs);
			this.pending.set(id, {
				method,
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
				const clientError = new LocalClientError(
					"WRITE_FAILED",
					`Failed writing to whalehall-local: ${errorMessage(error)}`,
				);
				reject(clientError);
				this.failChild(child, clientError, true);
			}
		});
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
			this.failChild(
				child,
				new LocalClientError(
					"PROTOCOL_ERROR",
					`whalehall-local stdout protocol failed: ${errorMessage(error)}`,
				),
				true,
			);
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
				if (text) console.error(`[whalehall-local:${child.pid}] ${text}`);
			}
		} catch (error) {
			console.error("Failed reading whalehall-local stderr:", error);
		} finally {
			reader.releaseLock();
		}
	}

	private handleLine(child: ChildTransport, line: string): void {
		if (child !== this.child) return;
		const message = parseLocalMessage(line);
		if (isDesktopEventFrame(message)) {
			for (const listener of this.desktopEventListeners) listener(message.data);
			return;
		}
		if (isToolEvent(message)) {
			for (const listener of this.eventListeners) listener(message);
			return;
		}
		if (message.id === null) {
			if (message.ok) throw new Error("Successful local response had no request id.");
			throw new Error(`${message.error.code}: ${message.error.message}`);
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pending.delete(message.id);
		if (message.ok) pending.resolve(message.result);
		else pending.reject(new LocalClientError(message.error.code, message.error.message));
	}

	private handleExit(child: ChildTransport, exitCode: number): void {
		if (child !== this.child) return;
		this.child = null;
		if (this.stopping) return;
		const error = new LocalClientError(
			"PROCESS_EXITED",
			`whalehall-local exited unexpectedly with code ${exitCode}.`,
		);
		this.rejectPending(error);
		this.emitFailure(error);
	}

	private protocolFailure(message: string): LocalClientError {
		const error = new LocalClientError("PROTOCOL_ERROR", message);
		const child = this.child;
		if (child) this.failChild(child, error, true);
		return error;
	}

	private failChild(child: ChildTransport, error: LocalClientError, kill: boolean): void {
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

	private rejectPending(error: LocalClientError): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private emitFailure(error: LocalClientError): void {
		for (const listener of this.failureListeners) listener(error);
	}

	private writeBestEffortCancel(child: ChildTransport, callId: string): void {
		if (child !== this.child) return;
		const request: LocalRequest = {
			id: crypto.randomUUID(),
			method: "tool.cancel",
			params: { callId },
		};
		try {
			child.stdin.write(`${JSON.stringify(request)}\n`);
			void child.stdin.flush();
		} catch {}
	}
}

function sameGoalContext(
	left: unknown,
	right: LocalEventGoalChange["previous"],
): boolean {
	if (left === null || right === null) return left === right;
	if (!isRecord(left)) return false;
	return (
		left.goalId === right.goalId &&
		left.planId === right.planId &&
		left.version === right.version &&
		left.text === right.text &&
		left.activatedAtMs === right.activatedAtMs
	);
}

async function closeGracefully(child: ChildTransport): Promise<void> {
	try {
		void child.stdin.end();
	} catch {}
	const exited = await Promise.race([
		child.exited.then(() => true),
		Bun.sleep(1000).then(() => false),
	]);
	if (exited) return;
	try {
		child.kill();
	} catch {}
}

export class JsonlProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JsonlProtocolError";
	}
}

export class JsonlParser {
	private buffer = new Uint8Array(0);
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });

	constructor(
		private readonly onLine: (line: string) => void,
		private readonly maxLineBytes: number,
	) {}

	feed(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;
		const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
		merged.set(this.buffer);
		merged.set(chunk, this.buffer.byteLength);
		let lineStart = 0;
		for (let index = 0; index < merged.byteLength; index += 1) {
			if (merged[index] !== 0x0a) continue;
			this.emitBytes(merged.subarray(lineStart, index));
			lineStart = index + 1;
		}
		this.buffer = merged.slice(lineStart);
		if (this.buffer.byteLength > this.maxLineBytes) {
			throw new JsonlProtocolError(
				`JSONL line exceeded ${this.maxLineBytes} bytes before a newline.`,
			);
		}
	}

	finish(): void {
		if (this.buffer.byteLength > 0) this.emitBytes(this.buffer);
		this.buffer = new Uint8Array(0);
	}

	private emitBytes(bytes: Uint8Array): void {
		const lineBytes = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
		if (lineBytes.byteLength > this.maxLineBytes) {
			throw new JsonlProtocolError(`JSONL line exceeded ${this.maxLineBytes} bytes.`);
		}
		try {
			this.onLine(this.decoder.decode(lineBytes));
		} catch (error) {
			if (error instanceof JsonlProtocolError) throw error;
			throw new JsonlProtocolError(errorMessage(error));
		}
	}
}

function isToolEvent(message: LocalMessage): message is LocalToolEvent {
	return "event" in message && message.event !== "desktop.event";
}

function isDesktopEventFrame(message: LocalMessage): message is LocalDesktopEventFrame {
	return "event" in message && message.event === "desktop.event";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
